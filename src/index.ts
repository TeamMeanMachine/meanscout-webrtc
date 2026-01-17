// Based on Maneuver's HTTP-based signaling server.
// https://github.com/ShinyShips/maneuver-core/blob/main/netlify/functions/webrtc-signal.ts

/** Grouping of peers and messages between peers. */
type Room = {
	id: string;
	peers: { id: string; info: any; lastUpdate: number }[];
	messages: StoredRtcMessage[];
	lastUpdate: number;
};

/** A message created by a client, to be sent to other clients. */
type IncomingRtcMessage = {
	type: 'offer' | 'answer' | 'candidate';
	roomId: string;
	peerId: string;
	toPeerId: string;
	data: any;
	delivered?: boolean | undefined;
};

/** Excludes redundant room id. */
type StoredRtcMessage = Omit<IncomingRtcMessage, 'roomId'>;

/** A message created by a client, sent to this server. */
type ClientMessage =
	| IncomingRtcMessage
	| { type: 'join'; roomId: string; peerId: string; peerInfo: any }
	| { type: 'leave'; roomId: string; peerId: string };

/** A message created by this server, to be sent to a client. */
type ServerMessage = { type: 'room'; room: Room } | { type: 'error'; error: string };

const corsHeaders: HeadersInit = {
	'access-control-allow-origin': '*',
	'access-control-allow-headers': 'content-type',
	'access-control-allow-methods': 'OPTIONS, POST, GET',
};

const headers: HeadersInit = { ...corsHeaders, 'content-type': 'application/json' };

const rooms = new Map<string, Room>();
const ROOM_TIMEOUT_5_MINUTES = 1000 * 60 * 5;

export default {
	async fetch(request) {
		switch (request.method) {
			case 'OPTIONS':
				return new Response(null, { status: 204, headers: { ...corsHeaders, allow: 'OPTIONS, POST, GET' } });
			case 'POST':
				return post(request);
			case 'GET':
				return get(request);
			default:
				return new Response(null, { status: 405, headers: { ...corsHeaders, allow: 'OPTIONS, POST, GET' } });
		}
	},

	async scheduled(controller) {
		for (const [roomId, room] of rooms.entries()) {
			if (controller.scheduledTime - room.lastUpdate > ROOM_TIMEOUT_5_MINUTES) {
				rooms.delete(roomId);
			}
		}
	},
} satisfies ExportedHandler<Env>;

/** Handles a message from a peer. */
async function post(request: Request) {
	const now = Date.now();

	let message: ClientMessage;

	try {
		message = await request.json();
	} catch {
		return jsonResponse(400, { type: 'error', error: 'Invalid JSON' });
	}

	if (!message.roomId) {
		return jsonResponse(400, { type: 'error', error: 'Missing roomId' });
	}

	if (!message.peerId) {
		return jsonResponse(400, { type: 'error', error: 'Missing peerId' });
	}

	let room = rooms.get(message.roomId);
	if (!room) {
		room = { id: message.roomId, peers: [], messages: [], lastUpdate: now };
		rooms.set(message.roomId, room);
	}

	room.lastUpdate = now;

	let existingPeer = room.peers.find((peer) => peer.id === message.peerId);

	let messages: StoredRtcMessage[];

	switch (message.type) {
		case 'join':
			if (existingPeer) {
				existingPeer.info = message.peerInfo;
				existingPeer.lastUpdate = now;
			} else {
				room.peers.push({ id: message.peerId, info: message.peerInfo, lastUpdate: now });
			}
			messages = handleIncomingMessagesForClient(room, message.peerId);
			return jsonResponse(200, { type: 'room', room: { ...room, messages } });
		case 'offer':
		case 'answer':
		case 'candidate':
			if (existingPeer) {
				existingPeer.lastUpdate = now;
			}
			room.messages.push({ type: message.type, peerId: message.peerId, toPeerId: message.toPeerId, data: message.data });
			messages = handleIncomingMessagesForClient(room, message.peerId);
			return jsonResponse(200, { type: 'room', room: { ...room, messages } });
		case 'leave':
			room.peers = room.peers.filter((peer) => peer.id !== message.peerId);
			room.messages = room.messages.filter((msg) => msg.peerId !== message.peerId && msg.toPeerId !== message.peerId);
			return new Response(null, { status: 200, headers: corsHeaders });
	}
}

/** Handles a query for room data from a peer. */
async function get(request: Request) {
	const now = Date.now();
	const url = new URL(request.url);

	const roomId = url.searchParams.get('roomId');
	if (!roomId) {
		return jsonResponse(400, { type: 'error', error: 'Missing roomId' });
	}

	const peerId = url.searchParams.get('peerId');
	if (!peerId) {
		return jsonResponse(400, { type: 'error', error: 'Missing peerId' });
	}

	const room = rooms.get(roomId);
	if (!room) {
		const fakeRoom: Room = { id: roomId, peers: [], messages: [], lastUpdate: now };
		return jsonResponse(200, { type: 'room', room: fakeRoom });
	}

	room.lastUpdate = now;

	let existingPeer = room.peers.find((peer) => peer.id === peerId);
	if (existingPeer) {
		existingPeer.lastUpdate = Date.now();
	}

	/** Messages for this peer. */
	const messages = handleIncomingMessagesForClient(room, peerId);
	return jsonResponse(200, { type: 'room', room: { ...room, messages } });
}

function handleIncomingMessagesForClient(room: Room, peerId: string) {
	/** Messages yet to be received by this peer. */
	const messages = room.messages.filter((msg) => msg.peerId !== peerId && msg.toPeerId === peerId && !msg.delivered);

	// Mark these messages as received by this peer.
	for (const msg of messages) {
		msg.delivered = true;
	}

	// Clean up fully delivered messages.
	room.messages = room.messages.filter((msg) => !msg.delivered);

	return messages;
}

function jsonResponse(status: number, message: ServerMessage) {
	return new Response(JSON.stringify(message), { status, headers });
}
