const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { randomBytes } = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const rooms = new Map();
const ROOM_TIMEOUT = 5 * 60 * 1000;
const RECONNECT_GRACE_MS = 2 * 60 * 1000;
const isTournament = room => room.settings.gameMode === 'tournament';
const connectedTournamentPlayers = room => [...room.players.values()].filter(p => !p.disconnected && p.chips > 0 && !p.id.startsWith('demo-'));

class Player {
  constructor(id, name, chips, seatIndex) {
    this.id = id;
    this.name = name;
    this.chips = chips;
    this.seatIndex = seatIndex;
    this.isActive = true;
    this.isSittingOut = false;
    this.holeCards = [];
    this.currentBet = 0;
    this.totalBet = 0;
    this.folded = false;
    this.allIn = false;
    this.hasActed = false;
    this.disconnected = false;
    this.hasRebought = false;
    this.waitingForNextHand = false;
    this.resumeToken = null; // private, never included in public game state
    this.reconnectTimer = null;
    this.wasSittingOut = false;
  }
  
  resetForHand() {
    this.holeCards = [];
    this.currentBet = 0;
    this.totalBet = 0;
    this.folded = false;
    this.allIn = false;
    this.hasActed = false;
  }
}

class Room {
  constructor(id, hostId, name, password, settings) {
    this.id = id;
    this.hostId = hostId;
    this.name = name;
    this.password = password;
    this.settings = settings;
    this.players = new Map();
    this.spectators = new Set();
    this.chat = [];
    this.gameState = {
      status: 'waiting',
      deck: [],
      communityCards: [],
      pots: [],
      currentPlayerIndex: -1,
      dealerIndex: -1,
      handNumber: 0,
      bettingRound: 'preflop',
      currentBet: 0,
      lastRaise: 0,
      minRaise: 0,
    };
    this.destructionTimeout = null;
    this.turnTimer = null;
    this.joinQueue = [];
    this.joinRequests = new Map();
    this.rebuyRequests = new Map();
    this.spectatorNames = new Map();
  }
  
  getPublicState(requestingSocketId = null) {
    const players = Array.from(this.players.values()).map(p => {
      let revealCards = false;
      if (this.gameState.bettingRound === 'showdown' && !p.folded) revealCards = true;
      if (p.id === requestingSocketId) revealCards = true;
      // Spectators never see live hole cards; only showdown reveals are public.
      return {
        id: p.id,
        name: p.name,
        chips: p.chips,
        seatIndex: p.seatIndex,
        isSittingOut: p.isSittingOut,
        hasRebought: p.hasRebought,
        disconnected: p.disconnected,
        folded: p.folded,
        allIn: p.allIn,
        currentBet: p.currentBet,
        holeCards: revealCards ? p.holeCards : [],
        isHost: this.hostId === p.id
      };
    });
    const spectators = Array.from(this.spectators).map(sid => ({
      id: sid,
      name: this.spectatorNames.get(sid) || 'Spectator',
      wantsJoin: this.joinRequests.has(sid),
      joinApproved: this.joinQueue.includes(sid)
    }));
    const rebuyRequests = Array.from(this.rebuyRequests.entries()).map(([pid, req]) => ({
      playerId: pid,
      playerName: req.name,
      amount: req.amount
    }));
    const joinRequests = Array.from(this.joinRequests.entries()).map(([sid, req]) => ({
      spectatorId: sid,
      name: req.name,
      approved: req.approved
    }));
    return {
      id: this.id,
      name: this.name,
      hostId: this.hostId,
      hasPassword: !!this.password,
      settings: this.settings,
      players,
      spectators,
      spectatorCount: this.spectators.size,
      rebuyRequests,
      joinRequests,
      gameState: {
        status: this.gameState.status,
        communityCards: this.gameState.communityCards,
        pots: this.gameState.pots,
        currentPlayerIndex: this.gameState.currentPlayerIndex,
        dealerIndex: this.gameState.dealerIndex,
        handNumber: this.gameState.handNumber,
        bettingRound: this.gameState.bettingRound,
        currentBet: this.gameState.currentBet,
        minRaise: this.gameState.minRaise,
        timerEnd: this.gameState.timerEnd || 0,
      },
      chat: this.chat.slice(-50)
    };
  }
}

function broadcastState(room) {
  room.players.forEach((_, sid) => io.to(sid).emit('state-update', room.getPublicState(sid)));
  room.spectators.forEach(sid => io.to(sid).emit('state-update', room.getPublicState(sid)));
}

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function createDeck() {
  const suits = ['s', 'h', 'd', 'c'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  const deck = [];
  for (let s of suits) for (let r of ranks) deck.push({ r, s });
  return deck;
}

function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

function rankValue(r) {
  return { '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, 'T':10, 'J':11, 'Q':12, 'K':13, 'A':14 }[r];
}

function evaluate5(cards) {
  const ranks = cards.map(c => rankValue(c.r)).sort((a,b) => b-a);
  const suits = cards.map(c => c.s);
  const isFlush = suits.every(s => s === suits[0]);
  let isStraight = true;
  for (let i=0; i<4; i++) {
    if (ranks[i] - 1 !== ranks[i+1]) { isStraight = false; break; }
  }
  if (ranks[0] === 14 && ranks[1] === 5 && ranks[2] === 4 && ranks[3] === 3 && ranks[4] === 2) {
    isStraight = true;
    ranks.push(ranks.shift());
  }
  const counts = {};
  ranks.forEach(r => counts[r] = (counts[r] || 0) + 1);
  const groups = Object.entries(counts).map(([r,c]) => [parseInt(r), c]).sort((a,b) => b[1] - a[1] || b[0] - a[0]);
  if (isFlush && isStraight) return { rank: 8, values: ranks, name: ranks[0] === 14 ? 'Royal Flush' : 'Straight Flush' };
  if (groups[0][1] === 4) return { rank: 7, values: [groups[0][0], groups[1][0]], name: 'Four of a Kind' };
  if (groups[0][1] === 3 && groups[1][1] === 2) return { rank: 6, values: [groups[0][0], groups[1][0]], name: 'Full House' };
  if (isFlush) return { rank: 5, values: ranks, name: 'Flush' };
  if (isStraight) return { rank: 4, values: ranks, name: 'Straight' };
  if (groups[0][1] === 3) return { rank: 3, values: [groups[0][0], groups[1][0], groups[2][0]], name: 'Three of a Kind' };
  if (groups[0][1] === 2 && groups[1][1] === 2) return { rank: 2, values: [groups[0][0], groups[1][0], groups[2][0]], name: 'Two Pair' };
  if (groups[0][1] === 2) return { rank: 1, values: [groups[0][0], groups[1][0], groups[2][0], groups[3][0]], name: 'One Pair' };
  return { rank: 0, values: ranks, name: 'High Card' };
}

function bestHand(cards) {
  let best = null;
  const n = cards.length;
  for(let i=0; i<n-4; i++)
    for(let j=i+1; j<n-3; j++)
      for(let k=j+1; k<n-2; k++)
        for(let l=k+1; l<n-1; l++)
          for(let m=l+1; m<n; m++) {
            const hand = evaluate5([cards[i],cards[j],cards[k],cards[l],cards[m]]);
            if (!best || compareHands(hand, best) > 0) best = hand;
          }
  return best;
}

function compareHands(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i=0; i<a.values.length; i++) {
    if (a.values[i] !== b.values[i]) return a.values[i] - b.values[i];
  }
  return 0;
}

function calculatePots(players) {
  let pots = [];
  let active = players.filter(p => !p.folded && p.totalBet > 0);
  let allContributors = players.filter(p => p.totalBet > 0);
  if (active.length === 0) {
    return [{ amount: allContributors.reduce((s,p)=>s+p.totalBet, 0), eligible: [] }];
  }
  // Every committed chip belongs in a pot, including small blinds and other
  // bets from players who folded. Using only active-player bet levels loses
  // uncalled folded contributions and can falsely eliminate tournament stacks.
  let levels = [...new Set(allContributors.map(p => p.totalBet))].sort((a,b) => a-b);
  let prevLevel = 0;
  for (let level of levels) {
    let diff = level - prevLevel;
    let contributors = allContributors.filter(p => p.totalBet >= level);
    let potAmount = diff * contributors.length;
    let eligible = active.filter(p => p.totalBet >= level).map(p => p.id);
    // Return a truly unmatched overbet to its only contributor instead of
    // allowing an empty-eligible side pot to swallow that chip balance.
    const refund = eligible.length === 0 && contributors.length === 1
      ? contributors[0].id : null;
    pots.push({ amount: potAmount, eligible, refund });
    prevLevel = level;
  }
  return pots;
}

function processJoinQueue(room) {
  if (room.joinQueue.length === 0) return;
  const usedSeats = new Set(Array.from(room.players.values()).map(p => p.seatIndex));
  const availableSeats = [];
  for (let i = 0; i < room.settings.maxPlayers; i++) {
    if (!usedSeats.has(i)) availableSeats.push(i);
  }
  while (room.joinQueue.length > 0 && availableSeats.length > 0) {
    const sid = room.joinQueue.shift();
    const name = room.spectatorNames.get(sid) || 'Player';
    const seatIndex = availableSeats.shift();
    const player = new Player(sid, name, room.settings.startingChips, seatIndex);
    room.players.set(sid, player);
    const promotedSocket = io.sockets.sockets.get(sid);
    if (promotedSocket) sendSeatToken(promotedSocket, room, player);
    room.spectators.delete(sid);
    room.joinRequests.delete(sid);
    io.to(sid).emit('set-spectator', false);
    io.to(sid).emit('joined-as-player', { seatIndex });
  }
}

function startGame(room) {
  if (room.players.size < 2) return;
  room.gameState.status = 'playing';
  if (room.gameState.dealerIndex === -1) {
    room.gameState.dealerIndex = Math.min(...Array.from(room.players.values()).map(p => p.seatIndex));
  }
  startHand(room);
}

function startHand(room) {
  // When nobody is connected, pause the tournament instead of endlessly
  // dealing hands and burning blind stacks in the background.
  if (isTournament(room) && connectedTournamentPlayers(room).length === 0) {
    room.gameState.status = 'waiting';
    broadcastState(room);
    return;
  }
  room.gameState.handNumber++;
  room.gameState.deck = createDeck();
  shuffleDeck(room.gameState.deck);
  room.gameState.communityCards = [];
  room.gameState.pots = [];
  room.gameState.currentBet = 0;
  room.gameState.lastRaise = room.settings.bigBlind;
  room.gameState.minRaise = room.settings.bigBlind;
  room.gameState.bettingRound = 'preflop';
  
  // Activate players who have rebought — they can now play again
  Array.from(room.players.values()).forEach(p => {
    if (p.hasRebought) {
      p.isSittingOut = false;
      p.hasRebought = false;
    }
  });
  
  // Cash-game absences sit out. Tournament absences must remain in the
  // rotation and post their scheduled blinds, even when disconnected.
  Array.from(room.players.values()).forEach(p => {
    if (p.disconnected) p.isSittingOut = !isTournament(room);
    if (p.waitingForNextHand && !p.disconnected) {
      p.waitingForNextHand = false;
      p.isSittingOut = false;
    }
  });
  // CRITICAL FIX: Reset ALL players' hand state at the start of every hand.
  Array.from(room.players.values()).forEach(p => p.resetForHand());
  
  const activePlayers = Array.from(room.players.values()).filter(p => p.chips > 0 && !p.isSittingOut);
  
  // Mark non-active players (bankrupt, sitting out, late joiners) as folded
  Array.from(room.players.values()).forEach(p => {
    if (!activePlayers.includes(p)) {
      p.folded = true;
    }
  });
  
  if (activePlayers.length < 2) {
    room.gameState.status = 'waiting';
    // Notify host why the hand couldn't start
    if (room.hostId) {
      io.to(room.hostId).emit('error-msg', 'Need at least 2 players with chips to start. Approve rebuy requests or wait for players to join.');
    }
    return;
  }
  
  const sortedSeats = activePlayers.map(p => p.seatIndex).sort((a,b) => a-b);
  let dealerIdx = sortedSeats.indexOf(room.gameState.dealerIndex);
  dealerIdx = (dealerIdx + 1) % sortedSeats.length;
  room.gameState.dealerIndex = sortedSeats[dealerIdx];
  const dealer = activePlayers.find(p => p.seatIndex === room.gameState.dealerIndex);
  const sbIdx = sortedSeats[(sortedSeats.indexOf(dealer.seatIndex) + 1) % sortedSeats.length];
  const bbIdx = sortedSeats[(sortedSeats.indexOf(dealer.seatIndex) + 2) % sortedSeats.length];
  const sbPlayer = activePlayers.length === 2 ? dealer : activePlayers.find(p => p.seatIndex === sbIdx);
  const bbPlayer = activePlayers.length === 2 ? activePlayers.find(p => p.seatIndex !== dealer.seatIndex) : activePlayers.find(p => p.seatIndex === bbIdx);
  postBlind(sbPlayer, room.settings.smallBlind);
  postBlind(bbPlayer, room.settings.bigBlind);
  room.gameState.currentBet = room.settings.bigBlind;
  for(let i=0; i<2; i++) {
    for(let p of activePlayers) {
      p.holeCards.push(room.gameState.deck.pop());
    }
  }
  if (isTournament(room)) {
    // Deal and charge blinds first; then automatically fold missing players.
    // A player whose blind took their final chips is all-in, not folded, and
    // still has a chance to win the pot.
    activePlayers.forEach(p => {
      if (p.disconnected && !p.allIn) {
        p.folded = true;
        p.hasActed = true;
      }
    });
  }
  const actors = activePlayers.filter(p => !p.folded && !p.allIn)
    .sort((a,b) => a.seatIndex - b.seatIndex);
  const firstActor = actors.find(p => p.seatIndex > bbPlayer.seatIndex) || actors[0];
  room.gameState.currentPlayerIndex = firstActor ? firstActor.seatIndex : -1;
  room.players.forEach((_, sid) => io.to(sid).emit('hand-started', room.getPublicState(sid)));
  room.spectators.forEach(sid => io.to(sid).emit('hand-started', room.getPublicState(sid)));
  if (isTournament(room) && (activePlayers.filter(p => !p.folded).length <= 1 ||
      actors.length <= 1)) {
    checkRoundComplete(room);
  } else {
    startTurnTimer(room);
  }
}

function postBlind(player, amount) {
  const blind = Math.min(amount, player.chips);
  player.chips -= blind;
  player.currentBet = blind;
  player.totalBet = blind;
  if (player.chips === 0) player.allIn = true;
}

function startTurnTimer(room) {
  clearTurnTimer(room);
  const player = getCurrentPlayer(room);
  if (!player) return;
  if (room.isDemo && player.id.startsWith('demo-')) {
    room.botTimer = setTimeout(() => {
      room.botTimer = null;
      if (room.gameState.status !== 'playing' || getCurrentPlayer(room)?.id !== player.id) return;
      processAction(player.id, player.currentBet < room.gameState.currentBet ? 'call' : 'check', 0);
    }, 650);
    return;
  }
  if (!room.settings.timerEnabled) {
    room.gameState.timerEnd = 0;
    room.players.forEach((_, sid) => io.to(sid).emit('turn-timer', { playerId: player.id, endTime: 0 }));
    room.spectators.forEach(sid => io.to(sid).emit('turn-timer', { playerId: player.id, endTime: 0 }));
    return;
  }
  room.gameState.timerEnd = Date.now() + room.settings.timerSeconds * 1000;
  room.players.forEach((_, sid) => io.to(sid).emit('turn-timer', { playerId: player.id, endTime: room.gameState.timerEnd }));
  room.spectators.forEach(sid => io.to(sid).emit('turn-timer', { playerId: player.id, endTime: room.gameState.timerEnd }));
  room.turnTimer = setTimeout(() => {
    processAction(player.id, 'fold', 0);
  }, room.settings.timerSeconds * 1000);
}

function clearTurnTimer(room) {
  if (room.botTimer) { clearTimeout(room.botTimer); room.botTimer = null; }
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  room.gameState.timerEnd = 0;
  room.players.forEach((_, sid) => io.to(sid).emit('turn-timer', { playerId: null, endTime: 0 }));
  room.spectators.forEach(sid => io.to(sid).emit('turn-timer', { playerId: null, endTime: 0 }));
}

function getCurrentPlayer(room) {
  return Array.from(room.players.values()).find(p => p.seatIndex === room.gameState.currentPlayerIndex && !p.folded && !p.allIn);
}

function processAction(playerId, action, amount) {
  const room = Array.from(rooms.values()).find(r => r.players.has(playerId));
  if (!room || room.gameState.status !== 'playing' ||
      room.gameState.bettingRound === 'showdown') return;
  const player = room.players.get(playerId);
  if (player.seatIndex !== room.gameState.currentPlayerIndex ||
      player.folded || player.allIn || player.disconnected) return;

  // Validate before clearing the turn timer. Previously a rejected check or
  // raise stopped the timer and could leave an entire multiplayer hand stuck.
  if (!['fold', 'check', 'call', 'raise'].includes(action)) return;
  if (action === 'check' && player.currentBet < room.gameState.currentBet) {
    io.to(playerId).emit('error-msg', 'You need to call, raise, or fold.');
    return;
  }
  const maxTotal = player.currentBet + player.chips;
  const minTotal = room.gameState.currentBet + room.gameState.minRaise;
  if (action === 'raise' &&
      (!Number.isSafeInteger(amount) || amount <= room.gameState.currentBet ||
       amount > maxTotal || (amount < minTotal && amount !== maxTotal))) {
    io.to(playerId).emit('error-msg', 'Invalid bet. Raise to at least $' +
      minTotal + ', or go all in.');
    return;
  }

  clearTurnTimer(room);
  if (action === 'fold') {
    player.folded = true;
    player.hasActed = true;
  } else if (action === 'check') {
    player.hasActed = true;
  } else if (action === 'call') {
    const callAmount = room.gameState.currentBet - player.currentBet;
    const actualCall = Math.min(callAmount, player.chips);
    player.chips -= actualCall;
    player.currentBet += actualCall;
    player.totalBet += actualCall;
    if (player.chips === 0) player.allIn = true;
    player.hasActed = true;
  } else if (action === 'raise') {
    const previousBet = room.gameState.currentBet;
    const raiseDiff = amount - player.currentBet;
    player.chips -= raiseDiff;
    player.currentBet = amount;
    player.totalBet += raiseDiff;
    const raiseAmount = amount - previousBet;
    if (raiseAmount >= room.gameState.minRaise) {
      room.gameState.minRaise = raiseAmount;
      room.gameState.lastRaise = amount;
      // An undersized all-in increase does not reopen raising to players who
      // have already acted, unlike a full legal raise.
      Array.from(room.players.values()).forEach(p => {
        if (p.id !== player.id && !p.folded && !p.allIn) p.hasActed = false;
      });
    }
    room.gameState.currentBet = amount;
    if (player.chips === 0) player.allIn = true;
    player.hasActed = true;
  }
  checkRoundComplete(room);
}

function checkRoundComplete(room) {
  const activePlayers = Array.from(room.players.values()).filter(p => !p.folded && !p.isSittingOut);
  const playersWhoCanAct = activePlayers.filter(p => !p.allIn);
  const roundOver = playersWhoCanAct.every(p => p.hasActed && p.currentBet === room.gameState.currentBet);
  const onlyOneLeft = activePlayers.filter(p => !p.folded).length === 1;
  if (roundOver || onlyOneLeft) {
    const pots = calculatePots(Array.from(room.players.values()));
    room.gameState.pots = pots;
    Array.from(room.players.values()).forEach(p => p.currentBet = 0);
    room.gameState.currentBet = 0;
    room.gameState.minRaise = room.settings.bigBlind;
    if (onlyOneLeft) {
      return endHand(room);
    }
    advanceRound(room);
  } else {
    moveToNextPlayer(room);
    startTurnTimer(room);
  }
  broadcastState(room);
}

function moveToNextPlayer(room) {
  const players = Array.from(room.players.values()).filter(p => !p.folded && !p.isSittingOut && !p.allIn);
  const sortedSeats = players.map(p => p.seatIndex).sort((a,b) => a-b);
  if (sortedSeats.length === 0) return;
  let idx = sortedSeats.indexOf(room.gameState.currentPlayerIndex);
  idx = (idx + 1) % sortedSeats.length;
  room.gameState.currentPlayerIndex = sortedSeats[idx];
}

function advanceRound(room) {
  while (true) {
    if (room.gameState.bettingRound === 'river') {
      return endHand(room);
    }
    if (room.gameState.bettingRound === 'preflop') {
      room.gameState.bettingRound = 'flop';
      room.gameState.deck.pop();
      for(let i=0; i<3; i++) room.gameState.communityCards.push(room.gameState.deck.pop());
    } else if (room.gameState.bettingRound === 'flop') {
      room.gameState.bettingRound = 'turn';
      room.gameState.deck.pop();
      room.gameState.communityCards.push(room.gameState.deck.pop());
    } else if (room.gameState.bettingRound === 'turn') {
      room.gameState.bettingRound = 'river';
      room.gameState.deck.pop();
      room.gameState.communityCards.push(room.gameState.deck.pop());
    } else {
      return endHand(room);
    }
    Array.from(room.players.values()).forEach(p => p.hasActed = false);
    const activePlayers = Array.from(room.players.values()).filter(p => !p.folded && !p.isSittingOut);
    const canActCount = activePlayers.filter(p => !p.allIn).length;
    if (canActCount > 1) {
      const sortedSeats = activePlayers.filter(p => !p.allIn)
        .map(p => p.seatIndex).sort((a,b) => a-b);
      const firstToActIdx = sortedSeats.find(seat => seat > room.gameState.dealerIndex) || sortedSeats[0];
      room.gameState.currentPlayerIndex = firstToActIdx;
      startTurnTimer(room);
      return;
    }
  }
}

function endHand(room) {
  clearTurnTimer(room);
  room.gameState.bettingRound = 'showdown';
  const pots = calculatePots(Array.from(room.players.values()));
  const activePlayers = Array.from(room.players.values()).filter(p => !p.folded);
  const results = [];
  pots.forEach(pot => {
    if (pot.refund) {
      const contributor = room.players.get(pot.refund);
      if (contributor) contributor.chips += pot.amount;
      return;
    }
    if (pot.eligible.length === 0) return;
    const eligiblePlayers = activePlayers.filter(p => pot.eligible.includes(p.id));
    if (eligiblePlayers.length === 0) return;
    if (eligiblePlayers.length === 1) {
      const w = eligiblePlayers[0];
      w.chips += pot.amount;
      results.push({ playerId: w.id, amount: pot.amount, hand: 'Win by Fold' });
      return;
    }
    const evaluated = eligiblePlayers.map(p => ({
      player: p,
      hand: bestHand([...p.holeCards, ...room.gameState.communityCards])
    }));
    evaluated.sort((a,b) => compareHands(b.hand, a.hand));
    const bestEval = evaluated[0].hand;
    const winners = evaluated.filter(e => compareHands(e.hand, bestEval) === 0);
    // Odd chips in split pots go clockwise from the dealer so every chip is
    // paid out, even when pot.amount isn't divisible by the number of winners.
    const orderedWinners = winners.sort((a,b) => {
      const n = room.settings.maxPlayers;
      return ((a.player.seatIndex - room.gameState.dealerIndex + n) % n) -
             ((b.player.seatIndex - room.gameState.dealerIndex + n) % n);
    });
    const winAmount = Math.floor(pot.amount / orderedWinners.length);
    let oddChips = pot.amount % orderedWinners.length;
    orderedWinners.forEach(w => {
      const amount = winAmount + (oddChips-- > 0 ? 1 : 0);
      w.player.chips += amount;
      results.push({ playerId: w.player.id, amount, hand: w.hand.name });
    });
  });
  broadcastState(room);
  room.players.forEach((_, sid) => io.to(sid).emit('hand-ended', { state: room.getPublicState(sid), results }));
  room.spectators.forEach(sid => io.to(sid).emit('hand-ended', { state: room.getPublicState(sid), results }));
  Array.from(room.players.values()).forEach(p => {
    if (p.chips === 0) {
      p.isSittingOut = true;
      if (isTournament(room)) {
        // Elimination revokes the ability to reclaim the seat. Never eliminate
        // earlier, since an all-in player can win chips back at showdown.
        p.resumeToken = null;
      }
    }
  });
  if (isTournament(room)) {
    for (const p of [...room.players.values()]) {
      if (p.disconnected && p.chips === 0) {
        if (p.reconnectTimer) clearTimeout(p.reconnectTimer);
        room.players.delete(p.id);
        transferHostIfNeeded(room, p.id);
      }
    }
  }
  // Advance normal rooms too. Never deal until two funded, active players are present.
  if (room._nextHandTimer) clearTimeout(room._nextHandTimer);
  room._nextHandTimer = setTimeout(() => {
    room._nextHandTimer = null;
    if (room.gameState.status !== 'playing' || room.gameState.bettingRound !== 'showdown') return;
    processJoinQueue(room);
    const eligible = Array.from(room.players.values()).filter(p => p.chips > 0 && !p.isSittingOut);
    if (eligible.length < 2 ||
        (isTournament(room) && connectedTournamentPlayers(room).length === 0)) {
      room.gameState.status = 'waiting';
      broadcastState(room);
      return;
    }
    startHand(room);
    broadcastState(room);
  // With only one connected tournament player, allow time between blind-only
  // hands instead of stripping absent stacks at 12 hands per minute.
  }, room.id === 'TEST01' ? 10 :
       (isTournament(room) && connectedTournamentPlayers(room).length < 2 ? 30000 : 5000));
}

// Tokens are kept server-side on the player object and delivered ONLY to their
// own socket. A room code or nickname is not proof of seat ownership.
function sendSeatToken(socket, room, player) {
  player.resumeToken = randomBytes(32).toString('hex');
  socket.emit('seat-resume-token', { roomCode: room.id, token: player.resumeToken,
    gameMode: room.settings.gameMode || 'cash' });
}

function roomForSocket(socketId) {
  return Array.from(rooms.values()).find(room =>
    room.players.has(socketId) || room.spectators.has(socketId));
}

function destroyIfEmpty(room) {
  const realPlayers = [...room.players.values()].filter(p => !p.id.startsWith('demo-'));
  if (room.players.size && (!room.isDemo || realPlayers.length)) return false;
  clearTurnTimer(room);
  if (room._nextHandTimer) clearTimeout(room._nextHandTimer);
  room.players.forEach(p => { if (p.reconnectTimer) clearTimeout(p.reconnectTimer); });
  rooms.delete(room.id);
  console.log('Room destroyed: ' + room.id);
  return true;
}

function transferHostIfNeeded(room, departingId) {
  if (room.hostId !== departingId) return;
  const eligible = Array.from(room.players.values())
    .filter(p => p.id !== departingId && !p.disconnected && !p.id.startsWith('demo-'));
  const successor = eligible.find(p => !p.isSittingOut && p.chips > 0) || eligible[0];
  room.hostId = successor?.id || null;
}

// A disconnected player auto-folds if still able to act; all-in players remain
// in the pot until showdown. Never delete a live all-in player's contribution.
function foldForDeparture(room, player) {
  if (room.gameState.status !== 'playing' ||
      room.gameState.bettingRound === 'showdown' || player.folded || player.allIn) return;
  if (room.gameState.currentPlayerIndex === player.seatIndex) {
    processAction(player.id, 'fold', 0);
  } else {
    player.folded = true;
    player.hasActed = true;
    const remaining = [...room.players.values()].filter(p => !p.folded);
    if (remaining.length === 1) endHand(room);
  }
}

function expireDisconnectedSeat(room, player) {
  if (rooms.get(room.id) !== room ||
      room.players.get(player.id) !== player || !player.disconnected) return;
  // Tournament seats have NO reconnect time limit while chips remain.
  if (isTournament(room) && player.chips > 0) return;
  if (player.allIn && !player.folded &&
      room.gameState.status === 'playing' && room.gameState.bettingRound !== 'showdown') {
    // Defer expiry until all-in side pots have been resolved.
    player.reconnectTimer = setTimeout(() => expireDisconnectedSeat(room, player), 30000);
    return;
  }
  room.players.delete(player.id);
  player.resumeToken = null;
  player.reconnectTimer = null;
  room.rebuyRequests.delete(player.id);
  transferHostIfNeeded(room, player.id);
  if (!destroyIfEmpty(room)) broadcastState(room);
}

function removeSeatImmediately(room, socketId) {
  if (room.spectators.has(socketId)) {
    room.spectators.delete(socketId);
    room.spectatorNames.delete(socketId);
    room.joinQueue = room.joinQueue.filter(id => id !== socketId);
    room.joinRequests.delete(socketId);
    room.rebuyRequests.delete(socketId);
  }
  const player = room.players.get(socketId);
  if (player && isTournament(room) && player.chips > 0) {
    player.wasSittingOut = player.isSittingOut;
    foldForDeparture(room, player);
    player.disconnected = true;
    if (!player.allIn) player.isSittingOut = false;
    if (player.reconnectTimer) clearTimeout(player.reconnectTimer);
    player.reconnectTimer = null;
    transferHostIfNeeded(room, player.id);
    broadcastState(room);
    return;
  }
  if (player) {
    // A voluntary exit mid-all-in is treated like a disconnection until the
    // hand completes: keeping the chips in the pot is mandatory.
    if (player.allIn && !player.folded && room.gameState.status === 'playing' &&
        room.gameState.bettingRound !== 'showdown') {
      player.disconnected = true;
      player.wasSittingOut = false;
      player.resumeToken = null;
      player.reconnectTimer = setTimeout(() => expireDisconnectedSeat(room, player), RECONNECT_GRACE_MS);
      broadcastState(room);
      return;
    }
    foldForDeparture(room, player);
    if (player.reconnectTimer) clearTimeout(player.reconnectTimer);
    room.players.delete(socketId);
    player.resumeToken = null;
    room.rebuyRequests.delete(socketId);
    transferHostIfNeeded(room, socketId);
  }
  if (!destroyIfEmpty(room)) broadcastState(room);
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  
  // Seamlessly resume after a refresh or a temporary network interruption.
  socket.on('resume-seat', (data) => {
    const room = typeof data?.roomCode === 'string' ? rooms.get(data.roomCode) : null;
    const token = typeof data?.token === 'string' ? data.token : '';
    if (!room || !/^[a-f0-9]{64}$/.test(token) || roomForSocket(socket.id)) {
      socket.emit('resume-failed');
      return;
    }
    const player = [...room.players.values()].find(p => p.resumeToken === token);
    if (!player) { socket.emit('resume-failed'); return; }

    const oldId = player.id;
    const oldSocket = io.sockets.sockets.get(oldId);
    if (player.reconnectTimer) clearTimeout(player.reconnectTimer);
    player.reconnectTimer = null;
    room.players.delete(oldId);
    player.id = socket.id;
    player.disconnected = false;
    // A fold in an interrupted hand remains final, but an eligible
    // tournament player is back in the next deal.
    player.isSittingOut = isTournament(room) ? player.chips === 0 : player.wasSittingOut;
    player.wasSittingOut = false;
    room.players.set(socket.id, player);
    if (room.hostId === oldId || (isTournament(room) && !room.hostId)) room.hostId = socket.id;
    if (room.rebuyRequests.has(oldId)) {
      const request = room.rebuyRequests.get(oldId);
      room.rebuyRequests.delete(oldId);
      room.rebuyRequests.set(socket.id, request);
    }
    socket.join(room.id);
    if (oldSocket && oldSocket.id !== socket.id) {
      oldSocket.emit('seat-replaced');
      oldSocket.leave(room.id);
      oldSocket.disconnect(true);
    }
    socket.emit('joined-room', room.getPublicState(socket.id));
    socket.emit('set-spectator', false);
    sendSeatToken(socket, room, player); // rotate token after every successful recovery
    broadcastState(room);
    if (isTournament(room) && room.gameState.status === 'waiting' &&
        room.players.size >= 2 && connectedTournamentPlayers(room).length > 0 &&
        [...room.players.values()].filter(p => p.chips > 0).length >= 2) {
      startGame(room);
      broadcastState(room);
    }
    console.log(`Seat restored: ${room.id}, seat ${player.seatIndex}`);
  });

  socket.on('leave-room', (ack) => {
    const room = roomForSocket(socket.id);
    if (room) removeSeatImmediately(room, socket.id);
    if (typeof ack === 'function') ack();
  });

  socket.on('test-game', (data = {}) => {
    if (roomForSocket(socket.id)) return socket.emit('error-msg', 'Leave your current table first.');
    const fullTable = data && data.fullTable === true;
    const id = generateRoomCode();
    const settings = { smallBlind: 10, bigBlind: 20, maxPlayers: 8, startingChips: 1000, timerSeconds: 20, timerEnabled: false, rebuysAllowed: true };
    const room = new Room(id, socket.id, fullTable ? 'Full Back Room' : 'Practice Table', '', settings);
    room.isDemo = true;
    const demoHuman = new Player(socket.id, 'You', 1000, 0);
    room.players.set(socket.id, demoHuman);
    const names = ['Greasy Lou', 'Deadeye', 'Ashtray Al', 'Silk', 'Knuckles', 'The Grinder', 'Mickey Mouth'];
    const count = fullTable ? 7 : 3;
    for (let i = 1; i <= count; i++) {
      const index = fullTable ? i : i * 2;
      const bot = new Player('demo-' + id + '-' + i, fullTable ? names[i - 1] : 'Bot ' + i, 1000, index);
      room.players.set(bot.id, bot);
    }
    rooms.set(id, room);
    socket.join(id);
    socket.emit('joined-room', room.getPublicState(socket.id));
    sendSeatToken(socket, room, demoHuman);
    startGame(room);
    broadcastState(room);
  });

  socket.on('create-room', (data) => {
    if (roomForSocket(socket.id)) return socket.emit('error-msg', 'Leave your current table first.');
    if (!data || typeof data !== 'object') return;
    if (!data.nickname || !data.nickname.trim()) return socket.emit('error-msg', 'Enter a nickname');
    const roomId = generateRoomCode();
    const settings = {
      smallBlind: Math.max(1, parseInt(data.smallBlind) || 10),
      bigBlind: Math.max(1, parseInt(data.bigBlind) || 20),
      maxPlayers: Math.max(2, Math.min(12, parseInt(data.maxPlayers) || 8)),
      startingChips: Math.max(1, parseInt(data.startingChips) || 1000),
      timerSeconds: Math.max(5, Math.min(120, parseInt(data.timerSeconds) || 20)),
      timerEnabled: data.timerEnabled !== undefined ? data.timerEnabled : true,
      gameMode: data.gameMode === 'tournament' ? 'tournament' : 'cash',
      rebuysAllowed: data.gameMode === 'tournament' ? false :
        (data.rebuysAllowed !== undefined ? data.rebuysAllowed : true)
    };
    const room = new Room(roomId, socket.id, data.roomName || data.nickname, data.password || '', settings);
    const player = new Player(socket.id, data.nickname, settings.startingChips, 0);
    room.players.set(socket.id, player);
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.emit('joined-room', room.getPublicState(socket.id));
    sendSeatToken(socket, room, player);
    console.log(`Room created: ${roomId}`);
  });
  
  socket.on('join-room', (data) => {
    if (roomForSocket(socket.id)) return socket.emit('error-msg', 'Leave your current table first.');
    if (!data || typeof data !== 'object') return;
    if (!data.nickname || !data.nickname.trim()) return socket.emit('error-msg', 'Enter a nickname');
    const room = rooms.get(data.roomCode);
    if (!room) return socket.emit('error-msg', 'Room not found');
    if (room.password && room.password !== data.password) return socket.emit('error-msg', 'Incorrect password');
    if (room.players.size >= room.settings.maxPlayers) return socket.emit('error-msg', 'Room is full');
    const seatIndex = Array.from({length: room.settings.maxPlayers}, (_, i) => i).find(i => !Array.from(room.players.values()).some(p => p.seatIndex === i));
    const player = new Player(socket.id, data.nickname, room.settings.startingChips, seatIndex);
    if (room.gameState.status === 'playing') {
      player.isSittingOut = true;
      player.waitingForNextHand = true;
    }
    room.players.set(socket.id, player);
    socket.join(room.id);
    socket.emit('joined-room', room.getPublicState(socket.id));
    sendSeatToken(socket, room, player);
    broadcastState(room);
  });
  
  socket.on('spectate-room', (data) => {
    if (roomForSocket(socket.id)) return socket.emit('error-msg', 'Leave your current table first.');
    if (!data || typeof data !== 'object') return;
    if (!data.nickname || !data.nickname.trim()) return socket.emit('error-msg', 'Enter a nickname');
    const room = rooms.get(data.roomCode);
    if (!room) return socket.emit('error-msg', 'Room not found');
    if (room.password && room.password !== data.password) return socket.emit('error-msg', 'Incorrect password');
    room.spectators.add(socket.id);
    room.spectatorNames.set(socket.id, data.nickname || 'Spectator');
    socket.join(room.id);
    socket.emit('joined-room', room.getPublicState(socket.id));
    socket.emit('set-spectator', true);
    broadcastState(room);
  });
  
  socket.on('list-public-rooms', () => {
    const allRooms = Array.from(rooms.values())
      .filter(r => r.players.size > 0)
      .map(r => ({
        id: r.id,
        name: r.name,
        playerCount: r.players.size,
        maxPlayers: r.settings.maxPlayers,
        isPlaying: r.gameState.status === 'playing',
        hasPassword: !!r.password,
        gameMode: r.settings.gameMode || 'cash'
      }));
    socket.emit('public-rooms', allRooms);
  });
  
  socket.on('start-game', () => {
    const room = Array.from(rooms.values()).find(r => r.players.has(socket.id) || r.spectators.has(socket.id));
    if (!room || room.hostId !== socket.id) return;
    processJoinQueue(room);
    Array.from(room.players.values()).forEach(p => {
      if (p.hasRebought) {
        p.isSittingOut = false;
        p.hasRebought = false;
      }
    });
    startGame(room);
    broadcastState(room);
  });

  socket.on('start-next-hand', () => {
    const room = Array.from(rooms.values()).find(r => r.players.has(socket.id) || r.spectators.has(socket.id));
    if (!room || room.hostId !== socket.id) return;
    if (room.gameState.status !== 'playing') return;
    if (room._nextHandTimer) {
      clearTimeout(room._nextHandTimer);
      room._nextHandTimer = null;
    }
    processJoinQueue(room);
    Array.from(room.players.values()).forEach(p => {
      if (p.hasRebought) {
        p.isSittingOut = false;
        p.hasRebought = false;
      }
    });
    startHand(room);
    broadcastState(room);
  });

  socket.on('request-join', () => {
    const room = Array.from(rooms.values()).find(r => r.spectators.has(socket.id));
    if (!room) return;
    if (!room.joinRequests.has(socket.id)) {
      room.joinRequests.set(socket.id, { name: room.spectatorNames.get(socket.id) || 'Spectator', approved: false });
    }
    socket.emit('join-requested', true);
    broadcastState(room);
  });

  socket.on('cancel-join', () => {
    const room = Array.from(rooms.values()).find(r => r.spectators.has(socket.id));
    if (!room) return;
    room.joinRequests.delete(socket.id);
    room.joinQueue = room.joinQueue.filter(id => id !== socket.id);
    socket.emit('join-requested', false);
    broadcastState(room);
  });

  socket.on('accept-join', (data) => {
    const room = Array.from(rooms.values()).find(r => r.hostId === socket.id);
    if (!room) return;
    const req = room.joinRequests.get(data.spectatorId);
    if (req) {
      req.approved = true;
      if (!room.joinQueue.includes(data.spectatorId)) {
        room.joinQueue.push(data.spectatorId);
      }
      io.to(data.spectatorId).emit('join-status', { status: 'approved' });
      broadcastState(room);
    }
  });

  socket.on('decline-join', (data) => {
    const room = Array.from(rooms.values()).find(r => r.hostId === socket.id);
    if (!room) return;
    room.joinRequests.delete(data.spectatorId);
    room.joinQueue = room.joinQueue.filter(id => id !== data.spectatorId);
    io.to(data.spectatorId).emit('join-status', { status: 'declined' });
    broadcastState(room);
  });

  socket.on('rebuy-request', (data) => {
    const room = Array.from(rooms.values()).find(r => r.players.has(socket.id));
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player || player.chips > 0 || !room.settings.rebuysAllowed) return;
    const amount = Math.max(1, parseInt(data.amount) || room.settings.startingChips);
    room.rebuyRequests.set(socket.id, { name: player.name, amount });
    socket.emit('rebuy-pending', true);
    broadcastState(room);
  });

  socket.on('cancel-rebuy', () => {
    const room = Array.from(rooms.values()).find(r => r.players.has(socket.id));
    if (!room) return;
    room.rebuyRequests.delete(socket.id);
    socket.emit('rebuy-pending', false);
    broadcastState(room);
  });

  socket.on('host-rebuy', (data) => {
    const room = Array.from(rooms.values()).find(r => r.hostId === socket.id && r.players.has(socket.id));
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player || player.chips > 0 || !room.settings.rebuysAllowed) return;
    const amount = Math.max(1, parseInt(data.amount) || room.settings.startingChips);
    player.chips = amount;
    player.hasRebought = true;
    socket.emit('rebuy-result', { approved: true, amount });
    broadcastState(room);
  });

  socket.on('approve-rebuy', (data) => {
    const room = Array.from(rooms.values()).find(r => r.hostId === socket.id);
    if (!room) return;
    const req = room.rebuyRequests.get(data.playerId);
    if (!req) return;
    const amount = Math.max(1, parseInt(data.amount) || req.amount);
    const player = room.players.get(data.playerId);
    if (player) {
      player.chips = amount;
      player.hasRebought = true;
    }
    room.rebuyRequests.delete(data.playerId);
    io.to(data.playerId).emit('rebuy-result', { approved: true, amount });
    broadcastState(room);
  });

  socket.on('decline-rebuy', (data) => {
    const room = Array.from(rooms.values()).find(r => r.hostId === socket.id);
    if (!room) return;
    room.rebuyRequests.delete(data.playerId);
    io.to(data.playerId).emit('rebuy-result', { approved: false });
    broadcastState(room);
  });

  socket.on('end-game', () => {
    const room = Array.from(rooms.values()).find(r => r.hostId === socket.id);
    if (!room) return;
    // Notify everyone EXCEPT the host (they already know — they triggered it)
    room.players.forEach((_, sid) => {
    if (sid !== socket.id) io.to(sid).emit('game-ended');
  });
    room.spectators.forEach(sid => io.to(sid).emit('game-ended'));
    // Clean up
    clearTurnTimer(room);
    if (room._nextHandTimer) clearTimeout(room._nextHandTimer);
    rooms.delete(room.id);
    console.log(`Game ended by host: ${room.id}`);
  });
  
  socket.on('action', (data) => {
    if (!data || typeof data.action !== 'string') return;
    const room = Array.from(rooms.values()).find(r => r.players.has(socket.id));
    if (!room) return;
    processAction(socket.id, data.action, data.amount);
  });
  
  socket.on('send-chat', (msg) => {
    const room = Array.from(rooms.values()).find(r => r.players.has(socket.id) || r.spectators.has(socket.id));
    if (!room) return;
    // Spectators are banned from chatting — better experience for players
    if (room.spectators.has(socket.id)) return;
    const player = room.players.get(socket.id);
    const senderName = player ? player.name : 'Spectator';
    const message = { sender: senderName, message: msg, timestamp: Date.now(), isSpectator: false };
    room.chat.push(message);
    // Only players receive chat messages
    room.players.forEach((_, sid) => io.to(sid).emit('chat-message', message));
  });
  
  socket.on('emoji', (emoji) => {
    const room = Array.from(rooms.values()).find(r => r.players.has(socket.id));
    if (!room) return;
    const player = room.players.get(socket.id);
    room.players.forEach((_, sid) => io.to(sid).emit('emoji-received', { playerId: socket.id, seatIndex: player.seatIndex, emoji }));
    room.spectators.forEach(sid => io.to(sid).emit('emoji-received', { playerId: socket.id, seatIndex: player.seatIndex, emoji }));
  });
  
  socket.on('host-action', (data) => {
    const room = Array.from(rooms.values()).find(r => r.hostId === socket.id);
    if (!room) return;
    if (data.type === 'kick') {
      // Kick a player — they become a spectator (NOT removed from game)
      const target = room.players.get(data.playerId);
      if (target) {
        // If it's their turn, fold first so the game doesn't stall
        if (room.gameState.currentPlayerIndex === target.seatIndex && room.gameState.status === 'playing') {
          processAction(data.playerId, 'fold', 0);
        }
        io.to(data.playerId).emit('kicked', { toSpectator: true });
        io.to(data.playerId).emit('set-spectator', true);
        target.isSittingOut = true;
        target.folded = true;
        room.spectators.add(data.playerId);
        room.spectatorNames.set(data.playerId, target.name);
        room.rebuyRequests.delete(data.playerId);
        room.players.delete(data.playerId);
        // If kicked player was host, transfer host to an active player first
        if (room.hostId === data.playerId) {
          const remaining = Array.from(room.players.values());
          const activeHost = remaining.find(p => !p.isSittingOut && p.chips > 0);
          if (activeHost) room.hostId = activeHost.id;
          else if (remaining.length > 0) room.hostId = remaining[0].id;
        }
        broadcastState(room);
      } else if (room.spectators.has(data.playerId)) {
        // Kick a spectator — they're removed entirely
        io.to(data.playerId).emit('kicked', { toSpectator: false });
        room.spectators.delete(data.playerId);
        room.spectatorNames.delete(data.playerId);
        room.joinQueue = room.joinQueue.filter(id => id !== data.playerId);
        room.joinRequests.delete(data.playerId);
        broadcastState(room);
      }
    } else if (data.type === 'edit-chips') {
      if (isTournament(room)) return;
      // Allow editing when game hasn't started, OR between hands (bettingRound === 'showdown')
      if (room.gameState.status === 'playing' && room.gameState.bettingRound !== 'showdown') return;
      const target = room.players.get(data.playerId);
      if (target) {
        target.chips = Math.max(0, parseInt(data.amount));
        // If chips set to > 0, clear sitting-out so they can play next hand
        if (target.chips > 0) {
          target.isSittingOut = false;
        }
        broadcastState(room);
      }
    } else if (data.type === 'change-password') {
      room.password = data.password;
      socket.emit('state-update', room.getPublicState(socket.id));
    } else if (data.type === 'toggle-rebuys') {
      if (isTournament(room)) return;
      room.settings.rebuysAllowed = !room.settings.rebuysAllowed;
      broadcastState(room);
    } else if (data.type === 'change-max-players') {
      room.settings.maxPlayers = Math.max(2, Math.min(12, parseInt(data.amount)));
      broadcastState(room);
    } else if (data.type === 'rebuy') {
      if (isTournament(room)) return;
      const target = room.players.get(data.playerId);
      if (target && target.chips === 0 && room.settings.rebuysAllowed) {
        target.chips = room.settings.startingChips;
        target.isSittingOut = false;
        broadcastState(room);
      }
    } else if (data.type === 'toggle-timer') {
      room.settings.timerEnabled = !room.settings.timerEnabled;
      if (!room.settings.timerEnabled) {
        clearTurnTimer(room);
        room.gameState.timerEnd = 0;
      } else if (room.settings.timerEnabled && room.gameState.status === 'playing') {
        startTurnTimer(room);
      }
      broadcastState(room);
    } else if (data.type === 'change-timer-duration') {
      const dur = Math.max(5, Math.min(120, parseInt(data.amount)));
      room.settings.timerSeconds = dur;
      if (room.settings.timerEnabled && room.gameState.status === 'playing') {
        startTurnTimer(room);
      }
      broadcastState(room);
    }
  });
  
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    const room = roomForSocket(socket.id);
    if (!room) return;
    if (room.spectators.has(socket.id)) {
      room.spectators.delete(socket.id);
      room.spectatorNames.delete(socket.id);
      room.joinQueue = room.joinQueue.filter(id => id !== socket.id);
      room.joinRequests.delete(socket.id);
      room.rebuyRequests.delete(socket.id);
    }
    const player = room.players.get(socket.id);
    if (player) {
      player.wasSittingOut = player.isSittingOut;
      foldForDeparture(room, player);
      player.disconnected = true;
      // Tournament stacks remain in rotation for blind postings; cash-game
      // absences sit out and expire normally.
      if (!player.allIn) player.isSittingOut = !isTournament(room);
      if (player.reconnectTimer) clearTimeout(player.reconnectTimer);
      player.reconnectTimer = isTournament(room) && player.chips > 0 ? null :
        setTimeout(() => expireDisconnectedSeat(room, player), RECONNECT_GRACE_MS);
      if (isTournament(room)) transferHostIfNeeded(room, player.id);
    }
    broadcastState(room);
  });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  if (process.argv.includes('--test')) {
    console.log('--- RUNNING IN TEST MODE ---');
    const testRoomId = 'TEST01';
    const settings = { smallBlind: 10, bigBlind: 20, maxPlayers: 6, startingChips: 1000, timerSeconds: 1, timerEnabled: true, rebuysAllowed: true };
    const room = new Room(testRoomId, 'bot0', 'Test Room', '', settings);
    rooms.set(testRoomId, room);
    for(let i=0; i<6; i++) {
      const botId = `bot${i}`;
      const player = new Player(botId, `Bot ${i+1}`, 1000, i);
      room.players.set(botId, player);
    }
    let handsPlayed = 0;
    const maxHands = 15;
    const runBotGame = () => {
      if (handsPlayed >= maxHands) {
        console.log('--- TEST COMPLETE ---');
        process.exit(0);
        return;
      }
      if (room.gameState.status === 'waiting') {
        startGame(room);
      }
      const playBotTurns = () => {
        const currentPlayer = getCurrentPlayer(room);
        if (!currentPlayer) { setTimeout(runBotGame, 10); return; }
        if (room.gameState.status !== 'playing') { setTimeout(runBotGame, 10); return; }
        const callAmount = room.gameState.currentBet - currentPlayer.currentBet;
        let action = 'fold';
        let amount = 0;
        const rand = Math.random();
        if (callAmount === 0) {
          action = rand < 0.7 ? 'check' : 'raise';
          amount = room.gameState.currentBet + room.settings.bigBlind;
        } else {
          if (rand < 0.3) action = 'fold';
          else if (rand < 0.8) action = 'call';
          else { action = 'raise'; amount = room.gameState.currentBet + room.settings.bigBlind; }
        }
        processAction(currentPlayer.id, action, amount);
        if (room.gameState.status === 'playing' && room.gameState.bettingRound !== 'showdown') {
          setTimeout(playBotTurns, 0);
        } else {
          handsPlayed++;
          console.log(`Hand ${handsPlayed} finished. Pot: ${room.gameState.pots.reduce((s,p)=>s+p.amount,0)}`);
          setTimeout(runBotGame, 10);
        }
      };
      setTimeout(playBotTurns, 10);
    };
    console.log('Starting 15 hand simulation...');
    runBotGame();
  }
});