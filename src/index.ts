import { DurableObject } from 'cloudflare:workers';

type ClientInfo = { id: string; name?: string; team?: string };
type InboundMessage = { type: 'signal'; to: string; data: any } | { type: 'info'; info: ClientInfo };
type OutboundMessage =
	| { type: 'join'; id: string; clients: ClientInfo[] }
	| { type: 'clients'; clients: ClientInfo[] }
	| { type: 'info'; info: ClientInfo }
	| { type: 'signal'; from: string; data: any }
	| { type: 'leave'; id: string }
	| { type: 'error'; error: string };

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
		const room = params.get('room') || undefined;
		const name = params.get('name') || undefined;
		const team = params.get('team') || undefined;

		if (name && name.length > MAX_NAME_LENGTH) {
			return new Response(`Name is too long (>${MAX_NAME_LENGTH} characters)`, { status: 400 });
		}

		if (team && team.length > MAX_TEAM_LENGTH) {
			return new Response(`Team is too long (>${MAX_TEAM_LENGTH} characters)`, { status: 400 });
		}

		const stub = env.rooms.getByName(room || 'public');
		return stub.fetch(request);
	},
} satisfies ExportedHandler<Env>;

export class Room extends DurableObject<Env> {
	clients: Map<WebSocket, ClientInfo>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.clients = new Map();

		for (const webSocket of this.ctx.getWebSockets()) {
			const peerInfo = webSocket.deserializeAttachment();
			if (!peerInfo) continue;
			this.clients.set(webSocket, peerInfo);
		}

		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
	}

	fetch(request: Request) {
		const params = new URL(request.url).searchParams;
		const name = params.get('name') || undefined;
		const team = params.get('team') || undefined;

		const [socketForClient, socketForServer] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(socketForServer);

		const info: ClientInfo = { id: crypto.randomUUID(), name, team };
		socketForServer.serializeAttachment(info);
		this.clients.set(socketForServer, info);

		this.sendTo(socketForServer, { type: 'join', id: info.id, clients: Array.from(this.clients.values()) });
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
			if (message.type !== 'info') {
				this.sendTo(webSocket, { type: 'error', error: 'Connection has no corresponding client info' });
				return;
			}

			clientInfo = {
				id: message.info.id.toString().trim(),
				name: message.info.name?.toString().trim(),
				team: message.info.team?.toString().trim(),
			};

			this.clients.set(webSocket, clientInfo);
			this.sendToAllExcept(webSocket, { type: 'info', info: clientInfo });
		}

		switch (message.type) {
			case 'signal':
				if (!message.to) {
					this.sendTo(webSocket, { type: 'error', error: 'Missing message "to" prop' });
					return;
				}

				for (const [otherWebSocket, otherClientInfo] of this.clients) {
					if (message.to !== otherClientInfo.id) continue;
					this.sendTo(otherWebSocket, { type: 'signal', from: clientInfo.id, data: message.data });
					return;
				}

				this.sendTo(webSocket, { type: 'error', error: 'Client not found with that id' });
				return;

			case 'info':
				if (!message.info) {
					this.sendTo(webSocket, { type: 'error', error: 'Missing message "info" prop' });
					return;
				}

				if (message.info.id !== clientInfo.id) {
					this.sendTo(webSocket, { type: 'error', error: 'Mismatching ids' });
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
				this.sendToAllExcept(webSocket, { type: 'info', info });
				return;

			default:
				this.sendTo(webSocket, { type: 'error', error: 'Invalid message type' });
				return;
		}
	}

	webSocketClose(webSocket: WebSocket, code: number, reason: string, wasClean: boolean) {
		const clientInfo = this.clients.get(webSocket);
		this.clients.delete(webSocket);

		if (clientInfo) {
			this.sendToAll({ type: 'leave', id: clientInfo.id });
			webSocket.close(code, `Closing WebSocket for id ${clientInfo.id}, wasClean: ${wasClean}, reason: ${reason}`);
		} else {
			this.sendToAll({ type: 'clients', clients: Array.from(this.clients.values()) });
			webSocket.close(code, `Closing WebSocket, wasClean: ${wasClean}, reason: ${reason}`);
		}
	}

	sendTo(webSocket: WebSocket, message: OutboundMessage) {
		webSocket.send(JSON.stringify(message));
	}

	sendToAll(message: OutboundMessage) {
		for (const [webSocket] of this.clients) {
			webSocket.send(JSON.stringify(message));
		}
	}

	sendToAllExcept(except: WebSocket, message: OutboundMessage) {
		for (const [otherWebSocket] of this.clients) {
			if (except === otherWebSocket) continue;
			otherWebSocket.send(JSON.stringify(message));
		}
	}
}
