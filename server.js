// server.js
const express = require('express');
const app = express();
const path = require('path');
const http = require('http').createServer(app);

const io = require('socket.io')(http, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

let rooms = {};

const BLIND_STRUCTURE = [
  { sb: 100, bb: 200 }, { sb: 200, bb: 400 }, { sb: 300, bb: 600 },
  { sb: 500, bb: 1000 }, { sb: 1000, bb: 2000 }, { sb: 2000, bb: 4000 }
];
const BLIND_DURATION = 5 * 60 * 1000; 

// 카드 랭크 값을 전역으로 분리 (봇 AI 계산용)
const rankValues = { '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10, 'J':11, 'Q':12, 'K':13, 'A':14 };

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

function createDeck() {
  const suits = ['♠', '♥', '♦', '♣']; const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  let deck = [];
  for (let s of suits) { for (let r of ranks) { deck.push({ suit: s, rank: r }); } }
  for (let i = deck.length - 1; i > 0; i--) { let j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  return deck;
}

function evaluateHand(holeCards, communityCards) {
  const allCards = [...holeCards, ...communityCards];
  let parsed = allCards.map(c => ({ suit: c.suit, rank: c.rank, val: rankValues[c.rank] }));
  parsed.sort((a, b) => b.val - a.val);

  function getStraight(cards) {
    let uniqueVals = [...new Set(cards.map(c => c.val))].sort((a, b) => b - a);
    if (uniqueVals.includes(14)) uniqueVals.push(1); 
    let straightHigh = 0; let streak = 1;
    for (let i = 0; i < uniqueVals.length - 1; i++) {
      if (uniqueVals[i] - 1 === uniqueVals[i+1]) { streak++; if (streak === 5) { straightHigh = uniqueVals[i-3]; break; } } else { streak = 1; }
    }
    return straightHigh;
  }

  let suitsCount = { '♠':[], '♥':[], '♦':[], '♣':[] };
  parsed.forEach(c => suitsCount[c.suit].push(c));
  let flushCards = Object.values(suitsCount).find(arr => arr.length >= 5);
  let isFlush = !!flushCards; let flushHigh = isFlush ? flushCards.slice(0,5) : null;

  let straightHigh = getStraight(parsed);
  let isStraightFlush = false; let straightFlushHigh = 0;
  if (isFlush) { straightFlushHigh = getStraight(flushCards); if (straightFlushHigh > 0) isStraightFlush = true; }

  let counts = {}; parsed.forEach(c => { counts[c.val] = (counts[c.val] || 0) + 1; });
  let countFreq = {}; 
  for (let val in counts) { let freq = counts[val]; if (!countFreq[freq]) countFreq[freq] = []; countFreq[freq].push(Number(val)); }
  for (let freq in countFreq) countFreq[freq].sort((a,b) => b - a);

  function calcScore(level, kickers) { let s = level * 10000000000; for(let i=0; i<5; i++) { s += (kickers[i] || 0) * Math.pow(100, 4-i); } return s; }

  let score = 0; let handName = "";
  if (isStraightFlush) { handName = "스트레이트 플러시"; score = calcScore(8, [straightFlushHigh]); } 
  else if (countFreq[4]) { handName = "포카드"; let kicker = parsed.find(c => c.val !== countFreq[4][0]).val; score = calcScore(7, [countFreq[4][0], countFreq[4][0], countFreq[4][0], countFreq[4][0], kicker]); } 
  else if (countFreq[3] && (countFreq[3].length > 1 || countFreq[2])) { handName = "풀하우스"; let three = countFreq[3][0]; let two = countFreq[3].length > 1 ? countFreq[3][1] : countFreq[2][0]; score = calcScore(6, [three, three, three, two, two]); } 
  else if (isFlush) { handName = "플러시"; score = calcScore(5, flushHigh.map(c=>c.val)); } 
  else if (straightHigh > 0) { handName = "스트레이트"; score = calcScore(4, [straightHigh]); } 
  else if (countFreq[3]) { handName = "트리플"; let kickers = parsed.filter(c => c.val !== countFreq[3][0]).slice(0,2).map(c=>c.val); score = calcScore(3, [countFreq[3][0], countFreq[3][0], countFreq[3][0], ...kickers]); } 
  else if (countFreq[2] && countFreq[2].length >= 2) { handName = "투페어"; let p1 = countFreq[2][0]; let p2 = countFreq[2][1]; let kicker = parsed.find(c => c.val !== p1 && c.val !== p2).val; score = calcScore(2, [p1, p1, p2, p2, kicker]); } 
  else if (countFreq[2]) { handName = "원페어"; let pair = countFreq[2][0]; let kickers = parsed.filter(c => c.val !== pair).slice(0,3).map(c=>c.val); score = calcScore(1, [pair, pair, ...kickers]); } 
  else { handName = "하이카드"; score = calcScore(0, parsed.slice(0,5).map(c=>c.val)); }
  return { score, handName, level: Math.floor(score / 10000000000) };
}

function distributePots(room) {
  let activeBettors = Object.values(room.players).filter(p => p.invested > 0).sort((a, b) => a.invested - b.invested);
  let pots = []; let previousInvested = 0;
  for (let i = 0; i < activeBettors.length; i++) {
    let p = activeBettors[i]; let contribution = p.invested - previousInvested;
    if (contribution > 0) {
      let potAmount = 0; let eligiblePlayers = [];
      for (let j = i; j < activeBettors.length; j++) {
        potAmount += contribution; let player = room.players[activeBettors[j].id];
        if (player.state !== 'folded' && player.state !== 'busted') eligiblePlayers.push(player);
      }
      if (potAmount > 0) pots.push({ amount: potAmount, eligible: eligiblePlayers });
      previousInvested = p.invested;
    }
  }
  let msgs = [];
  pots.forEach((pot, index) => {
    if (pot.eligible.length === 1) {
      let winner = pot.eligible[0]; winner.chips += pot.amount;
      msgs.push(pots.length > 1 ? `사이드 팟 ${index+1}(${pot.amount}칩): ${winner.name} (단독 획득)` : `총 팟(${pot.amount}칩): ${winner.name} (단독 획득)`);
    } else if (pot.eligible.length > 1) {
      let results = pot.eligible.map(p => {
        let evalResult = evaluateHand(p.cards, room.communityCards);
        return { pRef: p, score: evalResult.score, handName: evalResult.handName };
      });
      results.sort((a, b) => b.score - a.score);
      let highestScore = results[0].score; let winners = results.filter(r => r.score === highestScore);
      let splitAmount = Math.floor(pot.amount / winners.length);
      winners.forEach(w => { w.pRef.chips += splitAmount; });
      msgs.push(pots.length > 1 ? `사이드 팟 ${index+1}(${pot.amount}칩): ${winners.map(w=>w.pRef.name).join(", ")} 승리 (${winners[0].handName})` : `총 팟(${pot.amount}칩): ${winners.map(w=>w.pRef.name).join(", ")} 승리 (${winners[0].handName})`);
    }
  });
  return msgs;
}

function processShowdown(io, roomCode) {
  const room = rooms[roomCode]; room.stage = 5; 
  let msgs = distributePots(room);
  let finalMsg = `🔥 쇼다운 결과 🔥\n\n🃏 [바닥 카드]: ${room.communityCards.map(c => c.suit + c.rank).join(', ') || '없음'}\n\n`;
  let activePlayers = room.playerOrder.filter(id => room.players[id].state === 'playing');
  activePlayers.forEach(id => { 
    let p = room.players[id]; let evalResult = evaluateHand(p.cards, room.communityCards);
    finalMsg += `- ${p.name}: ${evalResult.handName} (${p.cards.map(c => c.suit + c.rank).join(', ')})\n`; 
  });
  finalMsg += `\n🎉 [팟 분배 결과]\n` + msgs.join('\n');
  io.to(roomCode).emit('update_game_state', getGameState(room));
  setTimeout(() => { io.to(roomCode).emit('system_message', finalMsg); }, 1500);
}

function processAllInShowdown(io, roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  if (room.stage < 4) {
    room.stage++; room.highestBet = 0; room.lastRaiseAmount = 0;
    if (room.stage === 1) { room.communityCards.push(room.deck.pop(), room.deck.pop(), room.deck.pop()); } 
    else if (room.stage === 2 || room.stage === 3) { room.communityCards.push(room.deck.pop()); }
    io.to(roomCode).emit('update_game_state', getGameState(room));
    setTimeout(() => processAllInShowdown(io, roomCode), 1500);
  } else { processShowdown(io, roomCode); }
}

// [핵심] 플레이어 및 봇의 액션을 공통으로 처리하는 함수
function handleAction(room, roomCode, player, data, io) {
  if(!room || room.status !== 'playing' || room.currentTurnId !== player.id) return; 
  player.acted = true; 

  if (data.action === 'call') {
    let callAmount = room.highestBet - player.currentBet;
    if(callAmount > 0) {
      if(callAmount > player.chips) callAmount = player.chips; 
      player.chips -= callAmount; player.currentBet += callAmount; player.invested += callAmount; room.pot += callAmount;
    }
  } else if (data.action === 'fold') { 
    player.state = 'folded'; 
  } else if (data.action === 'raise') {
    let raiseAmount = parseInt(data.amount);
    if (isNaN(raiseAmount) || raiseAmount < room.minRaise) raiseAmount = room.minRaise;
    let cost = raiseAmount - player.currentBet;
    if(cost >= player.chips) { cost = player.chips; raiseAmount = player.currentBet + cost; }
    player.chips -= cost; player.currentBet += cost; player.invested += cost; room.pot += cost; 
    
    if (raiseAmount > room.highestBet) {
      let raiseDiff = raiseAmount - room.highestBet;
      if (raiseDiff >= room.lastRaiseAmount) room.lastRaiseAmount = raiseDiff;
      room.highestBet = raiseAmount; room.minRaise = room.highestBet + room.lastRaiseAmount;
      room.playerOrder.forEach(id => { let p = room.players[id]; if(p.id !== player.id && p.state === 'playing' && p.chips > 0) p.acted = false; });
    }
  }

  const activePlayers = room.playerOrder.filter(id => room.players[id].state === 'playing' && !room.players[id].isOffline);
  if (activePlayers.length === 1) {
    const winner = room.players[activePlayers[0]];
    winner.chips += room.pot; room.stage = 5; room.uncontestedWinner = winner.id; 
    setTimeout(() => { io.to(roomCode).emit('system_message', `🎉 전원 폴드!\n[${winner.name}]님이 패를 숨긴 채 ${room.pot}칩을 가져갑니다.`); }, 500);
    io.to(roomCode).emit('update_game_state', getGameState(room));
    return;
  }

  const isRoundOver = activePlayers.every(id => { let p = room.players[id]; return p.acted && (p.currentBet === room.highestBet || p.chips === 0); });

  if (isRoundOver) {
    const playersWithChips = activePlayers.filter(id => room.players[id].chips > 0);
    if (playersWithChips.length <= 1 && room.stage < 4) {
        room.currentTurnId = null; processAllInShowdown(io, roomCode); return;
    }
    if (room.stage < 4) {
      room.stage++; room.highestBet = 0; 
      const currBB = (BLIND_STRUCTURE[room.blindLevel] || BLIND_STRUCTURE[BLIND_STRUCTURE.length - 1]).bb;
      room.lastRaiseAmount = currBB; room.minRaise = currBB; 
      activePlayers.forEach(id => { room.players[id].currentBet = 0; if (room.players[id].chips > 0) room.players[id].acted = false; });
      if (room.stage === 1) { room.communityCards.push(room.deck.pop(), room.deck.pop(), room.deck.pop()); } 
      else if (room.stage === 2 || room.stage === 3) { room.communityCards.push(room.deck.pop()); } 
      else if (room.stage === 4) { processShowdown(io, roomCode); return; }
      findNextTurn(room, activePlayers, true, roomCode, io);
    }
  } else { findNextTurn(room, activePlayers, false, roomCode, io); }

  io.to(roomCode).emit('update_game_state', getGameState(room));
}

// [신규] 방어적(Tight) 봇 판단 인공지능
function processBotDecision(room, roomCode, bot, io) {
  if (room.currentTurnId !== bot.id || room.status !== 'playing') return;

  const callAmount = room.highestBet - bot.currentBet;
  let action = 'fold'; let raiseAmt = 0;

  if (callAmount === 0) {
    action = 'call'; // 공짜 턴이면 무조건 체크
  } else {
    if (room.stage === 0) { // 프리플랍 (손패 2장만 있을 때)
      let v1 = rankValues[bot.cards[0].rank];
      let v2 = rankValues[bot.cards[1].rank];
      
      // 방어적 룰: 페어(쌍)이거나, 한 장이라도 10 이상(10, J, Q, K, A)이면 콜
      if (v1 === v2 || Math.max(v1, v2) >= 10) {
        action = 'call';
      }
    } else { // 포스트플랍 (바닥 카드 깔렸을 때)
      let evalResult = evaluateHand(bot.cards, room.communityCards);
      
      if (evalResult.level >= 3) { // 트리플(3) 이상 강한 패
        action = 'raise'; raiseAmt = room.minRaise * 2;
      } else if (evalResult.level >= 1) { // 원페어 ~ 투페어
        // 내 전 재산의 40% 이하의 베팅이면 따라감, 넘으면 쫄아서 폴드
        if (callAmount <= bot.chips * 0.4) action = 'call';
      } 
      // 하이카드(0)면 미련 없이 폴드
    }
  }

  // 봇이 파산할 위기면 자동으로 금액 조정
  if (action === 'raise' && raiseAmt >= bot.chips) { action = 'call'; }

  // 소켓 이벤트 대신 서버 함수 직접 호출
  handleAction(room, roomCode, bot, { action, amount: raiseAmt }, io);
}

// [수정] 봇 턴 트리거 추가
function findNextTurn(room, activePlayers, isNewStage, roomCode, io) {
  if (activePlayers.length === 0) { room.currentTurnId = null; return; }

  let turnIdx = 0;
  if (isNewStage) {
    let dealerIdx = activePlayers.indexOf(room.dealerId);
    turnIdx = dealerIdx === -1 ? 0 : dealerIdx; 
  } else {
    turnIdx = activePlayers.indexOf(room.currentTurnId);
    if (turnIdx === -1) turnIdx = 0;
  }

  let nextFound = false;
  for(let i=0; i<activePlayers.length; i++) {
    turnIdx = (turnIdx + 1) % activePlayers.length;
    let nextP = room.players[activePlayers[turnIdx]];
    if (nextP.state === 'playing' && nextP.chips > 0 && !nextP.isOffline) { 
      room.currentTurnId = nextP.id; nextFound = true; break; 
    }
  }
  if(!nextFound) room.currentTurnId = null; 

  // [핵심] 다음 턴이 봇이라면 1.5초 대기 후 생각(동작) 실행
  if (room.currentTurnId && room.players[room.currentTurnId].isBot) {
    setTimeout(() => {
      if (rooms[roomCode] === room && room.currentTurnId) {
        let bot = room.players[room.currentTurnId];
        if (bot && bot.isBot) processBotDecision(room, roomCode, bot, io);
      }
    }, 1500);
  }
}

function getGameState(room) {
  return {
    players: room.players, pot: room.pot, currentTurnId: room.currentTurnId, highestBet: room.highestBet, 
    minRaise: room.minRaise, communityCards: room.communityCards, stage: room.stage, 
    blindLevel: room.blindLevel, blindEndTime: room.blindEndTime, blinds: BLIND_STRUCTURE,
    uncontestedWinner: room.uncontestedWinner
  };
}

io.on('connection', (socket) => {
  
  socket.on('join_room', (data) => {
    const roomCode = data.roomCode;
    const playerName = data.playerName;
    
    socket.join(roomCode); socket.roomCode = roomCode;

    if (!rooms[roomCode]) {
      rooms[roomCode] = { 
        status: 'lobby', players: {}, playerOrder: [], deck: [],
        dealerId: null, currentTurnId: null, pot: 0, highestBet: 0,
        lastRaiseAmount: 200, minRaise: 200, stage: 0, communityCards: [],
        blindLevel: 0, blindEndTime: null, uncontestedWinner: null
      };
    }

    const room = rooms[roomCode];

    // [신규] 방 인원수(봇 포함) 10명 제한 로직
    if (Object.keys(room.players).length >= 10 && !Object.keys(room.players).find(k => room.players[k].name === playerName)) {
      return socket.emit('join_error', '⚠️ 방이 꽉 찼습니다. (최대 10명)');
    }

    let existingPlayerKey = Object.keys(room.players).find(key => room.players[key].name === playerName);
    
    if (existingPlayerKey) {
      let existingPlayer = room.players[existingPlayerKey];
      if (existingPlayer.isOffline) {
        existingPlayer.id = socket.id; existingPlayer.isOffline = false; 
        room.players[socket.id] = existingPlayer; delete room.players[existingPlayerKey];
        
        let orderIdx = room.playerOrder.indexOf(existingPlayerKey);
        if (orderIdx !== -1) room.playerOrder[orderIdx] = socket.id;

        if(room.dealerId === existingPlayerKey) room.dealerId = socket.id;
        if(room.currentTurnId === existingPlayerKey) room.currentTurnId = socket.id;
        if(room.uncontestedWinner === existingPlayerKey) room.uncontestedWinner = socket.id;

        if (room.status === 'playing') {
          socket.emit('game_started', getGameState(room)); io.to(roomCode).emit('update_game_state', getGameState(room));
        } else { io.to(roomCode).emit('update_lobby', Object.values(room.players)); }
        return; 
      } else { return socket.emit('join_error', '⚠️ 이미 접속 중인 닉네임입니다. 다른 닉네임을 사용해주세요.'); }
    }

    room.players[socket.id] = {
      id: socket.id, name: playerName, chips: 10000,
      isHost: room.playerOrder.filter(id => !room.players[id].isOffline && !room.players[id].isBot).length === 0, 
      cards: [], currentBet: 0, invested: 0, state: 'waiting', acted: false, rebuyCount: 0, isOffline: false, isBot: false
    };
    room.playerOrder.push(socket.id);
    
    if (room.status === 'playing') {
      socket.emit('game_started', getGameState(room)); io.to(roomCode).emit('update_game_state', getGameState(room));
    } else { io.to(roomCode).emit('update_lobby', Object.values(room.players)); }
  });

  // [신규] 방장의 봇 추가 요청 처리
  socket.on('add_bot', () => {
    const room = rooms[socket.roomCode];
    if (room && room.players[socket.id] && room.players[socket.id].isHost && room.status === 'lobby') {
      if (Object.keys(room.players).length >= 10) return socket.emit('system_message', '⚠️ 방이 꽉 찼습니다. (최대 10명)');
      
      let botCount = Object.values(room.players).filter(p => p.isBot).length;
      let botId = 'bot_' + Math.random().toString(36).substr(2, 9);
      
      room.players[botId] = {
        id: botId, name: `🤖 봇 ${botCount + 1}호`, chips: 10000,
        isHost: false, cards: [], currentBet: 0, invested: 0, state: 'waiting', 
        acted: false, rebuyCount: 0, isOffline: false, isBot: true
      };
      room.playerOrder.push(botId);
      io.to(socket.roomCode).emit('update_lobby', Object.values(room.players));
    }
  });

  socket.on('rebuy', () => {
    const room = rooms[socket.roomCode];
    if (room && room.players[socket.id]) {
      room.players[socket.id].chips += 10000; room.players[socket.id].rebuyCount += 1;
      io.to(socket.roomCode).emit('update_game_state', getGameState(room));
    }
  });

  socket.on('start_game', () => {
    const room = rooms[socket.roomCode];
    if (room && room.players[socket.id].isHost && (room.status === 'lobby' || room.stage === 5)) {
      
      if (!room.blindEndTime) { room.blindLevel = 0; room.blindEndTime = Date.now() + BLIND_DURATION; } 
      else if (Date.now() > room.blindEndTime) {
        room.blindLevel = Math.min(room.blindLevel + 1, BLIND_STRUCTURE.length - 1); room.blindEndTime = Date.now() + BLIND_DURATION;
      }

      // [신규] 봇이 파산했다면 새 게임 시작 시 자동으로 리바이(무료 충전) 처리
      Object.values(room.players).forEach(p => {
        if (p.isBot && p.chips === 0) { p.chips = 10000; p.rebuyCount++; }
      });

      const currBlinds = BLIND_STRUCTURE[room.blindLevel] || BLIND_STRUCTURE[BLIND_STRUCTURE.length - 1];
      const activeIds = room.playerOrder.filter(id => room.players[id].chips > 0 && !room.players[id].isOffline);
      if (activeIds.length < 2) return socket.emit('system_message', '칩을 가진 유저(또는 봇)가 최소 2명 필요합니다.');

      const isNextHand = (room.stage === 5);
      room.status = 'playing'; room.deck = createDeck();
      room.pot = 0; room.highestBet = currBlinds.bb; room.lastRaiseAmount = currBlinds.bb;
      room.minRaise = room.highestBet + room.lastRaiseAmount;
      room.stage = 0; room.communityCards = []; room.uncontestedWinner = null;

      let dIdx = 0;
      if (isNextHand && room.dealerId) {
        let prevDIdx = activeIds.indexOf(room.dealerId);
        dIdx = prevDIdx !== -1 ? (prevDIdx + 1) % activeIds.length : 0;
      } else if (!isNextHand) { activeIds.sort(() => Math.random() - 0.5); }
      room.dealerId = activeIds[dIdx];

      let sbIdx = (dIdx + 1) % activeIds.length; let bbIdx = (dIdx + 2) % activeIds.length; let utgIdx = (dIdx + 3) % activeIds.length;
      if (activeIds.length === 2) { sbIdx = dIdx; bbIdx = (dIdx + 1) % 2; utgIdx = dIdx; }
      room.currentTurnId = activeIds[utgIdx];

      Object.values(room.players).forEach(p => {
        p.state = p.chips > 0 ? 'waiting' : 'busted'; 
        p.cards = []; p.currentBet = 0; p.invested = 0; p.role = ''; p.acted = false;
      });

      activeIds.forEach((pId, idx) => {
        let p = room.players[pId];
        p.cards = [room.deck.pop(), room.deck.pop()]; p.state = 'playing';
        if (idx === sbIdx) { let cost = Math.min(p.chips, currBlinds.sb); p.chips -= cost; p.currentBet = cost; p.invested = cost; room.pot += cost; p.role = 'SB'; } 
        else if (idx === bbIdx) { let cost = Math.min(p.chips, currBlinds.bb); p.chips -= cost; p.currentBet = cost; p.invested = cost; room.pot += cost; p.role = 'BB'; } 
        else if (idx === dIdx) { p.role = 'D'; }
      });

      io.to(socket.roomCode).emit('game_started', getGameState(room));
      
      // 만약 첫 턴이 봇이라면 트리거 작동
      if (room.currentTurnId && room.players[room.currentTurnId].isBot) {
        setTimeout(() => { processBotDecision(room, socket.roomCode, room.players[room.currentTurnId], io); }, 1500);
      }
    }
  });

  socket.on('player_action', (data) => {
    try {
      const room = rooms[socket.roomCode];
      handleAction(room, socket.roomCode, room.players[socket.id], data, io);
    } catch (e) { console.error("서버 턴 처리 중 오류 방어:", e); }
  });

  socket.on('show_cards', () => {
    const room = rooms[socket.roomCode];
    if (room && room.stage === 5 && room.uncontestedWinner === socket.id) {
      const p = room.players[socket.id]; const cardsStr = p.cards.map(c => c.suit + c.rank).join(', ');
      io.to(socket.roomCode).emit('system_message', `😎 [패 공개] ${p.name}님이 기꺼이 카드를 공개합니다!\n👉 공개된 카드: ${cardsStr}`);
      room.uncontestedWinner = null; io.to(socket.roomCode).emit('update_game_state', getGameState(room));
    }
  });

  socket.on('end_game', () => {
    const room = rooms[socket.roomCode];
    if (room && room.players[socket.id] && room.players[socket.id].isHost) {
      let results = Object.values(room.players).map(p => {
        let totalInvested = 10000 + (p.rebuyCount * 10000);
        let profit = p.chips - totalInvested;
        return { name: p.name, chips: p.chips, rebuys: p.rebuyCount, profit: profit };
      });
      results.sort((a, b) => b.chips - a.chips);

      let finalMsg = `🏆 최종 정산 결과 🏆\n\n`;
      const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
      results.forEach((r, idx) => {
        let profitStr = r.profit > 0 ? `+${r.profit.toLocaleString()}` : `${r.profit.toLocaleString()}`;
        finalMsg += `${medals[idx] || '🔹'} [${r.name}]\n  💰 칩: ${r.chips.toLocaleString()} | 💸 리바이: ${r.rebuys}회\n  📈 순수익: ${profitStr}\n\n`;
      });
      io.to(socket.roomCode).emit('system_message', finalMsg);
      
      room.status = 'lobby'; room.blindLevel = 0; room.blindEndTime = null;
      
      // 오프라인이거나 '봇'인 유저는 정산 후 삭제하여 방을 깨끗하게 비움
      Object.keys(room.players).forEach(key => {
        if(room.players[key].isOffline || room.players[key].isBot) {
          delete room.players[key];
          room.playerOrder = room.playerOrder.filter(id => id !== key);
        } else {
          let p = room.players[key];
          p.chips = 10000; p.rebuyCount = 0; p.state = 'waiting'; p.cards = []; p.currentBet = 0; p.invested = 0; p.acted = false;
        }
      });
      io.to(socket.roomCode).emit('update_lobby', Object.values(room.players));
    }
  });

  socket.on('disconnect', () => {
    const roomCode = socket.roomCode;
    const room = rooms[roomCode];
    if (roomCode && room && room.players[socket.id]) {
      const player = room.players[socket.id];
      const wasHost = player.isHost; const isMyTurn = (room.currentTurnId === socket.id);
      
      player.isOffline = true;
      if (room.status === 'playing' && player.state === 'playing') player.state = 'folded';

      // 봇을 제외한 실제 접속자(사람)만 카운트
      const onlineHumans = room.playerOrder.filter(id => !room.players[id].isOffline && !room.players[id].isBot);

      if (onlineHumans.length === 0) {
        delete rooms[roomCode]; // 사람 없으면 방 폭파 (봇들만 남으면 의미 없음)
      } else {
        if (wasHost) { player.isHost = false; room.players[onlineHumans[0]].isHost = true; }
        if (room.status === 'playing' && isMyTurn) {
          const activePlayers = room.playerOrder.filter(id => room.players[id].state === 'playing' && !room.players[id].isOffline);
          if (activePlayers.length === 1) {
             const winner = room.players[activePlayers[0]];
             winner.chips += room.pot; room.stage = 5; room.uncontestedWinner = winner.id; room.currentTurnId = null;
             io.to(roomCode).emit('system_message', `🎉 [${player.name}] 님의 탈주로 인해\n[${winner.name}]님이 ${room.pot}칩을 획득합니다.`);
             io.to(roomCode).emit('update_game_state', getGameState(room));
          } else {
             findNextTurn(room, activePlayers, false, roomCode, io);
             io.to(roomCode).emit('update_game_state', getGameState(room));
          }
        } else {
          if (room.status === 'lobby') io.to(roomCode).emit('update_lobby', Object.values(room.players));
          else io.to(roomCode).emit('update_game_state', getGameState(room));
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => { console.log(`🚀 봇 AI 장착 홀덤 서버 가동! (포트: ${PORT})`); });