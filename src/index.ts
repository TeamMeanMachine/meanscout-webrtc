/** Contains a group of peers. */
type Room = { id: string; peers: { id: string; info: any; socket?: WebSocket }[] };

type RTCMessageType = 'offer' | 'answer' | 'ice-candidate';

/** A message created by a client, sent to this server. */
type ClientMessage =
	| { type: 'join'; roomId: string; peerId: string; peerInfo: any }
	| { type: RTCMessageType; roomId: string; peerId: string; toPeerId: string; rtcData: any }
	| { type: 'leave'; roomId: string; peerId: string }
	| { type: 'ping' };

/** A message created by this server, to be sent to one or many peers. */
type ServerMessage =
	| { type: 'room-info'; roomId: string; peers: { id: string; info: any }[] }
	| { type: 'peer-join'; peerId: string; peerInfo: any }
	| { type: `peer-${RTCMessageType}`; peerId: string; data: any }
	| { type: 'peer-leave'; peerId: string }
	| { type: 'pong' }
	| { type: 'error'; error: string };

const rooms = new Map<string, Room>();

export default {
	async fetch(request) {
		if (request.headers.get('upgrade') === 'websocket') {
			const client = handleWebSocket();
			return new Response(null, { status: 101, webSocket: client });
		}

		return new Response();
	},

	async scheduled() {
		for (const [roomId, room] of rooms.entries()) {
			if (!room.peers.length) {
				rooms.delete(roomId);
			}
		}
	},
} satisfies ExportedHandler<Env>;

function handleWebSocket() {
	let dataForThisSocket: { peerId: string; roomId: string } | undefined = undefined;

	const [client, server] = Object.values(new WebSocketPair());
	server.accept();

	server.addEventListener('open', (event) => {
		console.log('web socket server opened', event);
	});

	server.addEventListener('error', (event) => {
		console.error('web socket server error', event);
	});

	server.addEventListener('close', (event) => {
		console.log('web socket server closed', event);

		if (dataForThisSocket) {
			let room = rooms.get(dataForThisSocket.roomId);

			if (room) {
				handlePeerLeave(dataForThisSocket.peerId, room);
			}
		}

		dataForThisSocket = undefined;
	});

	server.addEventListener('message', async (event) => {
		console.log('web socket server message', event);

		let message: ClientMessage;

		try {
			message = await JSON.parse(event.data);
		} catch {
			server.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' } satisfies ServerMessage));
			return;
		}

		if (message.type === 'ping') {
			server.send(JSON.stringify({ type: 'pong' } satisfies ServerMessage));
			return;
		}

		if (!message.roomId) {
			server.send(JSON.stringify({ type: 'error', error: 'roomId is required' } satisfies ServerMessage));
			return;
		}

		if (!message.peerId) {
			server.send(JSON.stringify({ type: 'error', error: 'peerId is required' } satisfies ServerMessage));
			return;
		}

		if (dataForThisSocket && dataForThisSocket.peerId !== message.peerId) {
			server.send(JSON.stringify({ type: 'error', error: 'peerId is different' } satisfies ServerMessage));
			return;
		}

		if (dataForThisSocket && dataForThisSocket.roomId !== message.roomId) {
			server.send(JSON.stringify({ type: 'error', error: 'roomId is different' } satisfies ServerMessage));
			return;
		}

		let room = rooms.get(message.roomId);

		if (!room) {
			room = { id: message.roomId, peers: [] };
			rooms.set(message.roomId, room);
		}

		if (!dataForThisSocket) {
			dataForThisSocket = { peerId: message.peerId, roomId: message.roomId };
		}

		switch (message.type) {
			case 'join':
				let existingPeer = room.peers.find((peer) => peer.id === message.peerId);

				if (existingPeer) {
					existingPeer.info = message.peerInfo;
					existingPeer.socket?.close();
					existingPeer.socket = server;
				} else {
					room.peers.push({ id: message.peerId, info: message.peerInfo, socket: server });
				}

				for (const peer of room.peers) {
					if (peer.id !== message.peerId) {
						peer.socket?.send(
							JSON.stringify({ type: 'peer-join', peerId: message.peerId, peerInfo: message.peerInfo } satisfies ServerMessage),
						);
					}
				}

				server.send(
					JSON.stringify({
						type: 'room-info',
						roomId: room.id,
						peers: room.peers.map((peer) => ({ ...peer, socket: undefined })),
					} satisfies ServerMessage),
				);

				break;

			case 'offer':
			case 'answer':
			case 'ice-candidate':
				room.peers
					.find((peer) => peer.id == message.toPeerId)
					?.socket?.send(
						JSON.stringify({ type: `peer-${message.type}`, peerId: message.peerId, data: message.rtcData } satisfies ServerMessage),
					);

				break;

			case 'leave':
				handlePeerLeave(message.peerId, room);
				dataForThisSocket = undefined;
				break;
		}
	});

	return client;
}

/** Removes a peer from a room. Either notifies other peers or deletes the now-empty room. */
function handlePeerLeave(peerId: string, room: Room) {
	room.peers = room.peers.filter((peer) => peer.id !== peerId);

	if (room.peers.length) {
		for (const peer of room.peers) {
			peer.socket?.send(JSON.stringify({ type: 'peer-leave', peerId } satisfies ServerMessage));
		}
	} else {
		rooms.delete(room.id);
	}
}
