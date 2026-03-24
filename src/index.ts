import { DurableObject } from 'cloudflare:workers';

type ClientInfo = { id: string; name?: string; team?: string };

type InboundCandidateMessage = { type: 'candidate'; to: string; candidate: any };
type InboundMessage =
	| { type: 'offer'; to: string; offer: any }
	| { type: 'answer'; to: string; answer: any }
	| InboundCandidateMessage
	| { type: 'info'; info: { name?: string; team?: string } }
	| { type: 'leave' }
	| { type: 'batch'; messages: InboundCandidateMessage[] };

type OutboundCandidateMessage = { type: 'candidate'; from: string; candidate: any };
type OutboundMessage =
	| { type: 'init'; id: string; clients: ClientInfo[] }
	| { type: 'clients'; clients: ClientInfo[] }
	| { type: 'info'; info: ClientInfo }
	| { type: 'offer'; from: string; offer: any }
	| { type: 'answer'; from: string; answer: any }
	| OutboundCandidateMessage
	| { type: 'leave'; id: string }
	| { type: 'error'; error: string }
	| { type: 'batch'; messages: OutboundCandidateMessage[] };

const MAX_NAME_LENGTH = 32;
const MAX_TEAM_LENGTH = 6;

export default {
	async fetch(request, env) {
		const upgradeHeader = request.headers.get('Upgrade');

		if (!upgradeHeader || upgradeHeader !== 'websocket') {
			return new Response('Worker expected Upgrade: websocket', { status: 426 });
		}

		if (request.method !== 'GET') {
			return new Response('Worker expected GET method', { status: 400 });
		}

		const params = new URL(request.url).searchParams;
		const room = params.get('room');
		const name = params.get('name');
		const team = params.get('team');

		if (!room) {
			return new Response('No room', { status: 400 });
		}

		if (name && name.length > MAX_NAME_LENGTH) {
			return new Response(`Name is too long (>${MAX_NAME_LENGTH} characters)`, { status: 400 });
		}

		if (team && team.length > MAX_TEAM_LENGTH) {
			return new Response(`Team is too long (>${MAX_TEAM_LENGTH} characters)`, { status: 400 });
		}

		const stub = env.rooms.getByName(room);
		return stub.fetch(request);
	},
} satisfies ExportedHandler<Env>;

export class Room extends DurableObject<Env> {
	clients: Map<WebSocket, ClientInfo>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.clients = new Map();

		for (const webSocket of this.ctx.getWebSockets()) {
			const client = webSocket.deserializeAttachment();
			if (!client) continue;
			this.clients.set(webSocket, client);
		}
	}

	// Only the Cloudflare Worker can access this Durable Object,
	// so we don't have to validate params again.
	fetch(request: Request) {
		const params = new URL(request.url).searchParams;
		const name = params.get('name') || undefined;
		const team = params.get('team') || undefined;

		const id = crypto.randomUUID();

		const [socketForClient, socketForServer] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(socketForServer);

		const info: ClientInfo = { id, name, team };
		this.clients.set(socketForServer, info);
		socketForServer.serializeAttachment(info);

		this.sendTo(socketForServer, { type: 'init', id, clients: Array.from(this.clients.values()) });
		this.sendToAllExcept(socketForServer, { type: 'info', info });
		return new Response(null, { status: 101, webSocket: socketForClient });
	}

	webSocketMessage(webSocket: WebSocket, rawMessage: string | ArrayBuffer) {
		if (typeof rawMessage !== 'string') {
			this.sendTo(webSocket, { type: 'error', error: 'Invalid message' });
			return;
		}

		let message: InboundMessage;

		try {
			message = JSON.parse(rawMessage);
		} catch (err) {
			this.sendTo(webSocket, { type: 'error', error: 'Message could not be parsed' });
			return;
		}

		if (typeof message !== 'object') {
			this.sendTo(webSocket, { type: 'error', error: 'Invalid message' });
			return;
		}

		if (!message.type) {
			this.sendTo(webSocket, { type: 'error', error: 'Missing message "type" prop' });
			return;
		}

		let clientInfo = this.clients.get(webSocket);

		if (!clientInfo) {
			this.sendTo(webSocket, { type: 'error', error: 'Connection has no corresponding client info' });
			return;
		}

		switch (message.type) {
			case 'offer':
			case 'answer':
			case 'candidate':
				if (!message.to) {
					this.sendTo(webSocket, { type: 'error', error: 'Missing message "to" prop' });
					return;
				}

				const relayedMessage: OutboundMessage =
					message.type == 'offer'
						? { type: 'offer', from: clientInfo.id, offer: message.offer }
						: message.type == 'answer'
							? { type: 'answer', from: clientInfo.id, answer: message.answer }
							: { type: 'candidate', from: clientInfo.id, candidate: message.candidate };

				for (const [otherWebSocket, otherClientInfo] of this.clients) {
					if (message.to !== otherClientInfo.id) continue;
					this.sendTo(otherWebSocket, relayedMessage);
					return;
				}

				this.sendTo(webSocket, { type: 'error', error: 'Client not found with that id' });
				return;

			case 'info':
				if (!message.info) {
					this.sendTo(webSocket, { type: 'error', error: 'Missing message "info" prop' });
					return;
				}

				const info: ClientInfo = {
					id: clientInfo.id,
					name: message.info.name?.toString().trim(),
					team: message.info.team?.toString().trim(),
				};

				if (info.name && info.name.length > MAX_NAME_LENGTH) {
					this.sendTo(webSocket, { type: 'error', error: `Name is too long (>${MAX_NAME_LENGTH} characters)` });
					return;
				}

				if (info.team && info.team.length > MAX_TEAM_LENGTH) {
					this.sendTo(webSocket, { type: 'error', error: `Team is too long (>${MAX_TEAM_LENGTH} characters)` });
					return;
				}

				this.clients.set(webSocket, info);
				webSocket.serializeAttachment(info);
				this.sendToAllExcept(webSocket, { type: 'info', info });
				return;

			case 'leave':
				this.clients.delete(webSocket);

				if (clientInfo) {
					this.sendToAll({ type: 'leave', id: clientInfo.id });
				}

				return;

			case 'batch':
				if (!message.messages || !Array.isArray(message.messages)) {
					this.sendTo(webSocket, { type: 'error', error: 'No batched messages' });
					return;
				}

				const messagesPerRecipient = new Map<WebSocket, Extract<OutboundMessage, { type: 'candidate' }>[]>();

				for (const msg of message.messages) {
					if (typeof msg !== 'object') {
						this.sendTo(webSocket, { type: 'error', error: 'Invalid message in batch' });
						continue;
					}

					if (!msg.type) {
						this.sendTo(webSocket, { type: 'error', error: 'Missing message "type" prop in batch' });
						continue;
					}

					if (msg.type !== 'candidate') {
						this.sendTo(webSocket, { type: 'error', error: 'Batched messages must be of type "candidate"' });
						continue;
					}

					if (!msg.to) {
						this.sendTo(webSocket, { type: 'error', error: 'Missing message "to" prop in batch' });
						continue;
					}

					for (const [otherWebSocket, otherClientInfo] of this.clients) {
						if (msg.to !== otherClientInfo.id) continue;

						// We should be on the one client that matches the id here.

						const messagesForThisRecipient = messagesPerRecipient.get(otherWebSocket) || [];
						messagesForThisRecipient.push({ type: 'candidate', from: clientInfo.id, candidate: msg.candidate });

						messagesPerRecipient.set(otherWebSocket, messagesForThisRecipient);
					}
				}

				if (messagesPerRecipient.size == 0) {
					this.sendTo(webSocket, { type: 'error', error: 'Client not found with matching id in batch' });
					return;
				}

				for (const [otherWebSocket, messages] of messagesPerRecipient) {
					this.sendTo(otherWebSocket, { type: 'batch', messages });
				}

				return;

			default:
				this.sendTo(webSocket, { type: 'error', error: 'Invalid message type' });
				return;
		}
	}

	webSocketClose(webSocket: WebSocket) {
		const clientInfo = this.clients.get(webSocket);
		this.clients.delete(webSocket);

		if (clientInfo) {
			this.sendToAll({ type: 'leave', id: clientInfo.id });
			webSocket.close();
		}
	}

	sendTo(webSocket: WebSocket, message: OutboundMessage) {
		this.trySend(webSocket, message);
	}

	sendToAll(message: OutboundMessage) {
		for (const [webSocket] of this.clients) {
			this.trySend(webSocket, message);
		}
	}

	sendToAllExcept(except: WebSocket, message: OutboundMessage) {
		for (const [otherWebSocket] of this.clients) {
			if (except === otherWebSocket) continue;
			this.trySend(otherWebSocket, message);
		}
	}

	trySend(webSocket: WebSocket, message: OutboundMessage) {
		try {
			webSocket.send(JSON.stringify(message));
		} catch (err) {
			// Assume that this client isn't connected,
			// so remove them and notify all remaining clients.
			const clientInfo = this.clients.get(webSocket);
			this.clients.delete(webSocket);

			if (clientInfo) {
				this.sendToAll({ type: 'leave', id: clientInfo.id });
			} else {
				this.sendToAll({ type: 'clients', clients: Array.from(this.clients.values()) });
			}
		}
	}
}
