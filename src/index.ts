// Based on Maneuver's signaling server.
// https://github.com/ShinyShips/Maneuver-2025/blob/main/netlify/functions/webrtc-signal.ts

/** Grouping of peers and messages between peers. */
type Room = {
	id: string;
	peers: { id: string; data: any; lastSeenAt: number }[];
	messages: StorableMessage[];
	createdAt: number;
};

/** A message between peers that should persist in a room. */
type StorableMessage =
	| {
			type: 'offer';
			roomId: string;
			peerId: string;
			offer: any;
			sendingTo?: string[] | undefined;
			deliveredTo?: string[] | undefined;
	  }
	| {
			type: 'answer';
			roomId: string;
			peerId: string;
			answer: any;
			sendingTo?: string[] | undefined;
			deliveredTo?: string[] | undefined;
	  }
	| {
			type: 'ice-candidate';
			roomId: string;
			peerId: string;
			candidate: any;
			sendingTo?: string[] | undefined;
			deliveredTo?: string[] | undefined;
	  }
	| {
			type: 'join';
			roomId: string;
			peerId: string;
			peerData: any;
			sendingTo?: string[] | undefined;
			deliveredTo?: string[] | undefined;
	  };

type SignalingMessage =
	| StorableMessage
	| {
			type: 'leave';
			roomId: string;
			peerId: string;
	  }
	| { type: 'ping' };

const corsHeaders: HeadersInit = {
	'access-control-allow-origin': '*',
	'access-control-allow-headers': 'content-type',
	'access-control-allow-methods': 'OPTIONS, POST, GET',
};

const headers: HeadersInit = { ...corsHeaders, 'content-type': 'application/json' };

const rooms = new Map<string, Room>();
const ROOM_TIMEOUT_5_MINUTES = 30 * 60 * 1000 * 5;

export default {
	async fetch(request) {
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: { ...corsHeaders, allow: 'OPTIONS, POST, GET' },
			});
		}

		if (request.method === 'POST') {
			return post(request);
		}

		if (request.method === 'GET') {
			return get(request);
		}

		return new Response();
	},

	async scheduled(controller) {
		for (const [roomId, room] of rooms.entries()) {
			if (controller.scheduledTime - room.createdAt > ROOM_TIMEOUT_5_MINUTES) {
				rooms.delete(roomId);
			}
		}
	},
} satisfies ExportedHandler<Env>;

/** Handles a message from a peer. */
async function post(request: Request) {
	const now = Date.now();

	let message: SignalingMessage;

	try {
		message = await request.json();
	} catch {
		return new Response(JSON.stringify({ type: 'error', error: 'Invalid JSON' }), { status: 400, headers });
	}

	if (message.type === 'ping') {
		return new Response(JSON.stringify({ type: 'pong' }), { status: 200, headers });
	}

	if (!message.roomId || !message.peerId) {
		return new Response(JSON.stringify({ type: 'error', error: 'roomId and peerId props are required' }), { status: 400, headers });
	}

	let room = rooms.get(message.roomId);
	if (!room) {
		room = { id: message.roomId, peers: [], messages: [], createdAt: now };
		rooms.set(message.roomId, room);
	}

	switch (message.type) {
		case 'offer':
		case 'answer':
		case 'ice-candidate':
			room.messages.push({ ...message, deliveredTo: [] });
			break;
		case 'join':
			let existingPeer = room.peers.find((peer) => peer.id === message.peerId);
			if (existingPeer) {
				existingPeer.data = message.peerData;
				existingPeer.lastSeenAt = now;
			} else {
				room.peers.push({ id: message.peerId, data: message.peerData, lastSeenAt: now });
			}
			room.messages.push({ ...message, deliveredTo: [] });
			break;
		case 'leave':
			room.peers = room.peers.filter((peer) => peer.id !== message.peerId);
			break;
	}

	return new Response(JSON.stringify({ type: 'room', room }), { status: 200, headers });
}

/** Handles a query for room data from a peer. */
async function get(request: Request) {
	const url = new URL(request.url);

	const roomId = url.searchParams.get('roomId');
	const peerId = url.searchParams.get('peerId');

	if (!roomId || !peerId) {
		return new Response(JSON.stringify({ type: 'error', error: 'roomId and peerId params are required' }), { status: 400, headers });
	}

	const room = rooms.get(roomId);

	if (!room) {
		const fakeRoom: Room = { id: roomId, peers: [], messages: [], createdAt: Date.now() };
		return new Response(JSON.stringify({ type: 'room', room: fakeRoom }), { status: 200, headers });
	}

	/** Messages yet to be received by this peer. */
	const messages = room.messages.filter((message) => {
		const notAuthor = message.peerId !== peerId;
		const isRecipient = message.sendingTo?.includes(peerId);
		const notDelivered = !message.deliveredTo?.includes(peerId);
		return notAuthor && isRecipient && notDelivered;
	});

	// Mark these messages as received by this peer.
	messages.forEach((message) => {
		if (!message.deliveredTo) {
			message.deliveredTo = [];
		}
		message.deliveredTo.push(peerId);
	});

	room.messages = room.messages.filter((message) => {
		if (!message.deliveredTo) {
			return true;
		}

		if (message.type === 'join') {
			const someNotDelivered = room.peers.some((peer) => !message.deliveredTo?.includes(peer.id));
			return someNotDelivered;
		}

		return message.deliveredTo.length < (message.sendingTo?.length || 1);
	});

	return new Response(JSON.stringify({ type: 'room', room: { ...room, messages } }), { status: 200, headers });
}
