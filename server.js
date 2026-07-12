// server.js
const express = require('express');
const app = express();
const path = require('path');
const http = require('http').createServer(app);

// 👇 이 줄을 새로 추가합니다.
app.use(express.static(path.join(__dirname, 'public')));

const io = require('socket.io')(http, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

let rooms = {};

const BLIND_STRUCTURE = [
  { sb: 100, bb: 200 }, { sb: 200, bb: 400 }, { sb: 300, bb: 600 },
  { sb: 500, bb: 1000 }, { sb: 1000, bb: 2000 }, { sb: 2000, bb: 4000 }
];
const BLIND_DURATION = 5 * 60 * 1000; 

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
      msgs.push(pots.length > 1 ? `사이드 팟 ${index+1}(${pot.amount}칩): ${winner.name}` : `총 팟(${pot.amount}칩): ${winner.name}`);
    } else if (pot.eligible.length > 1) {
      let results = pot.eligible.map(p => {
        let evalResult = evaluateHand(p.cards, room.communityCards);
        return { pRef: p, score: evalResult.score, handName: evalResult.handName };
      });
      results.sort((a, b) => b.score - a.score);
      let highestScore = results[0].score; let winners = results.filter(r => r.score === highestScore);
      let splitAmount = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount % winners.length; // 나누고 남은 짜투리 칩 계산
      
      winners.forEach((w, idx) => { 
        w.pRef.chips += splitAmount; 
        if (idx === 0) w.pRef.chips += remainder; // 남은 짜투리 칩은 무승부 승자 중 첫 번째 사람에게 지급
      });
      msgs.push(pots.length > 1 ? `사이드 팟 ${index+1}(${pot.amount}칩): ${winners.map(w=>w.pRef.name).join(", ")} (${winners[0].handName})` : `총 팟(${pot.amount}칩): ${winners.map(w=>w.pRef.name).join(", ")} (${winners[0].handName})`);
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
    io.to(roomCode).emit('play_sound', 'deal'); // 사운드 트리거
    setTimeout(() => processAllInShowdown(io, roomCode), 1500);
  } else { processShowdown(io, roomCode); }
}

function handleAction(room, roomCode, player, data, io) {
  if(!room || room.status !== 'playing' || room.currentTurnId !== player.id) return; 
  player.acted = true; 
  let actionLog = '';

  if (data.action === 'call') {
    let callAmount = room.highestBet - player.currentBet;
    if(callAmount > 0) {
      if(callAmount > player.chips) callAmount = player.chips; 
      player.chips -= callAmount; player.currentBet += callAmount; player.invested += callAmount; room.pot += callAmount;
      actionLog = `[${player.name}] 님이 콜을 받았습니다. (${callAmount}칩)`;
      io.to(roomCode).emit('play_sound', 'bet');
    } else {
      actionLog = `[${player.name}] 님이 체크했습니다.`;
      io.to(roomCode).emit('play_sound', 'check');
    }
  } else if (data.action === 'fold') { 
    player.state = 'folded'; 
    actionLog = `❌ [${player.name}] 님이 폴드했습니다.`;
    io.to(roomCode).emit('play_sound', 'fold');
  } else if (data.action === 'raise') {
    let raiseAmount = parseInt(data.amount);
    let maxPossibleBet = player.currentBet + player.chips;
    
    if (isNaN(raiseAmount)) raiseAmount = room.minRaise;
    if (raiseAmount < room.minRaise && raiseAmount !== maxPossibleBet) { raiseAmount = room.minRaise; }

    let cost = raiseAmount - player.currentBet;
    if(cost >= player.chips) { 
      cost = player.chips; 
      raiseAmount = player.currentBet + cost; 
    }
    
    player.chips -= cost; player.currentBet += cost; player.invested += cost; room.pot += cost; 
    
    let isAllIn = player.chips === 0;
    actionLog = isAllIn ? `🔥 [${player.name}] 님이 올인했습니다! (${cost}칩)` : `📈 [${player.name}] 님이 레이즈했습니다. (총 ${raiseAmount}칩)`;
    io.to(roomCode).emit('play_sound', 'raise');

    if (raiseAmount > room.highestBet) {
      let raiseDiff = raiseAmount - room.highestBet;
      room.highestBet = raiseAmount; 
      if (raiseDiff >= room.lastRaiseAmount) {
        room.lastRaiseAmount = raiseDiff;
        room.minRaise = room.highestBet + room.lastRaiseAmount;
        room.playerOrder.forEach(id => { 
          let p = room.players[id]; 
          if(p.id !== player.id && p.state === 'playing' && p.chips > 0) p.acted = false; 
        });
      }
    }
  }

  // 액션 로그 전송
  if (actionLog) io.to(roomCode).emit('chat_message', { type: 'log', msg: actionLog });

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
        room.currentTurnId = null; 
        io.to(roomCode).emit('chat_message', { type: 'log', msg: '🔥 전원 올인! 남은 카드를 한 번에 오픈합니다.' });
        processAllInShowdown(io, roomCode); return;
    }
    if (room.stage < 4) {
      room.stage++; room.highestBet = 0; 
      const currBB = (BLIND_STRUCTURE[room.blindLevel] || BLIND_STRUCTURE[BLIND_STRUCTURE.length - 1]).bb;
      room.lastRaiseAmount = currBB; room.minRaise = currBB; 
      activePlayers.forEach(id => { room.players[id].currentBet = 0; if (room.players[id].chips > 0) room.players[id].acted = false; });
      if (room.stage === 1) { room.communityCards.push(room.deck.pop(), room.deck.pop(), room.deck.pop()); } 
      else if (room.stage === 2 || room.stage === 3) { room.communityCards.push(room.deck.pop()); } 
      else if (room.stage === 4) { processShowdown(io, roomCode); return; }
      io.to(roomCode).emit('play_sound', 'deal');
      findNextTurn(room, activePlayers, true, roomCode, io);
    }
  } else { findNextTurn(room, activePlayers, false, roomCode, io); }

  io.to(roomCode).emit('update_game_state', getGameState(room));
}

function processBotDecision(room, roomCode, bot, io) {
  if (room.currentTurnId !== bot.id || room.status !== 'playing') return;

  const callAmount = room.highestBet - bot.currentBet;
  let action = 'fold'; let raiseAmt = 0;
  let rand = Math.random(); // 0~1 사이의 난수 (봇의 변덕)

  if (room.stage === 0) {
    // [1] 프리플랍 (시작 카드 2장만 있는 상태)
    let v1 = rankValues[bot.cards[0].rank];
    let v2 = rankValues[bot.cards[1].rank];
    let maxV = Math.max(v1, v2);

    if (v1 === v2 && v1 >= 10) { 
      action = 'raise'; raiseAmt = room.minRaise * 2; // QQ, KK, AA면 크게 레이즈
    } else if (v1 === v2 || maxV >= 10) { 
      action = 'call'; 
      if (callAmount === 0 && rand < 0.2) { action = 'raise'; raiseAmt = room.minRaise; } // 20% 확률로 삥(블러핑)
    } else {
      // 안 좋은 카드일 때
      if (callAmount === 0 || callAmount <= room.minRaise) { action = 'call'; } // 공짜거나 싸면 일단 봄
      else if (rand < 0.1) { action = 'call'; } // 10% 확률로 무지성 콜
    }
  } else { 
    // [2] 플랍 이후 (바닥 카드가 깔린 상태)
    let evalResult = evaluateHand(bot.cards, room.communityCards);

    if (evalResult.level >= 3) { // 트리플 이상 (매우 강력함)
      action = 'raise';
      raiseAmt = rand < 0.5 ? room.minRaise * 2 : room.minRaise * 3;
    } 
    else if (evalResult.level >= 1) { // 원페어/투페어
      if (callAmount === 0) {
        action = rand < 0.4 ? 'raise' : 'call'; // 40% 확률로 블러핑 레이즈
        raiseAmt = room.minRaise;
      } else if (callAmount <= bot.chips * 0.5) { // 내 남은 칩의 50% 이하 베팅이면 따라감
        action = 'call';
      }
    } 
    else { // 족보가 없을 때(하이카드)
      if (callAmount === 0) {
         action = rand < 0.2 ? 'raise' : 'call'; // 20% 확률로 약한 뻥카
         raiseAmt = room.minRaise;
      }
    }
  }

  // [공통 보정] 올인 규칙 및 눈치(체크) 적용
  if (action === 'raise' && raiseAmt >= bot.chips) { raiseAmt = bot.chips + bot.currentBet; }
  // 폴드할 상황인데 앞에 낸 돈이 없으면 굳이 안 죽고 체크(콜)로 묻어감
  if (action === 'fold' && callAmount === 0) { action = 'call'; } 

  handleAction(room, roomCode, bot, { action, amount: raiseAmt }, io);
}

function findNextTurn(room, activePlayers, isNewStage, roomCode, io) {
  if (activePlayers.length === 0) { room.currentTurnId = null; return; }

  let currentOrderIdx = 0;
  if (isNewStage) {
    currentOrderIdx = room.playerOrder.indexOf(room.dealerId);
  } else {
    currentOrderIdx = room.playerOrder.indexOf(room.currentTurnId);
  }

  let nextFound = false;
  for(let i = 0; i < room.playerOrder.length; i++) {
    currentOrderIdx = (currentOrderIdx + 1) % room.playerOrder.length;
    let nextPId = room.playerOrder[currentOrderIdx];

    if (activePlayers.includes(nextPId)) {
      let nextP = room.players[nextPId];
      if (nextP.state === 'playing' && nextP.chips > 0 && !nextP.isOffline) {
        if (!nextP.acted || nextP.currentBet < room.highestBet) {
          room.currentTurnId = nextP.id;
          nextFound = true;
          break;
        }
      }
    }
  }
  if(!nextFound) room.currentTurnId = null;

  if (room.currentTurnId && room.players[room.currentTurnId].isBot) {
    const expectedTurnId = room.currentTurnId; // 타이머를 시작할 때의 봇 ID를 기억해둡니다.
    
    setTimeout(() => {
      // 시간이 지난 후에도 방이 존재하고, 현재 턴이 방금 기억해둔 그 봇의 턴이 맞을 때만 실행합니다.
      if (rooms[roomCode] === room && room.currentTurnId === expectedTurnId) {
        let bot = room.players[room.currentTurnId];
        if (bot && bot.isBot) processBotDecision(room, roomCode, bot, io);
      }
    }, 1500 + Math.random() * 1000);
  } else if (room.currentTurnId) {
    io.to(room.currentTurnId).emit('play_sound', 'my_turn');
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
        
        io.to(roomCode).emit('chat_message', { type: 'sys', msg: `🚪 ${playerName} 님이 재접속했습니다.` });
        return; 
      } else { return socket.emit('join_error', '⚠️ 이미 접속 중인 닉네임입니다. 다른 닉네임을 사용해주세요.'); }
    }

    room.players[socket.id] = {
      id: socket.id, name: playerName, chips: 10000,
      isHost: room.playerOrder.filter(id => !room.players[id].isOffline && !room.players[id].isBot).length === 0, 
      cards: [], currentBet: 0, invested: 0, state: 'waiting', acted: false, rebuyCount: 0, pendingRebuy: 0, isOffline: false, isBot: false
    };
    room.playerOrder.push(socket.id);
    
    if (room.status === 'playing') {
      socket.emit('game_started', getGameState(room)); io.to(roomCode).emit('update_game_state', getGameState(room));
    } else { io.to(roomCode).emit('update_lobby', Object.values(room.players)); }
    
    io.to(roomCode).emit('chat_message', { type: 'sys', msg: `🚪 ${playerName} 님이 입장했습니다.` });
  });

  socket.on('add_bot', () => {
    const room = rooms[socket.roomCode];
    if (room && room.players[socket.id] && room.players[socket.id].isHost && room.status === 'lobby') {
      if (Object.keys(room.players).length >= 10) return socket.emit('system_message', '⚠️ 방이 꽉 찼습니다. (최대 10명)');
      
      let botCount = Object.values(room.players).filter(p => p.isBot).length;
      let botId = 'bot_' + Math.random().toString(36).substr(2, 9);
      
      room.players[botId] = {
        id: botId, name: `🤖 봇 ${botCount + 1}호`, chips: 10000,
        isHost: false, cards: [], currentBet: 0, invested: 0, state: 'waiting', 
        acted: false, rebuyCount: 0, pendingRebuy: 0, isOffline: false, isBot: true
      };
      room.playerOrder.push(botId);
      io.to(socket.roomCode).emit('update_lobby', Object.values(room.players));
    }
  });

  // [신규] 방장 강퇴 기능
  socket.on('kick_player', (targetId) => {
    const room = rooms[socket.roomCode];
    if (room && room.players[socket.id] && room.players[socket.id].isHost) {
      const target = room.players[targetId];
      if (target) {
        io.to(targetId).emit('kicked_out');
        io.to(socket.roomCode).emit('chat_message', { type: 'sys', msg: `⛔ 방장이 ${target.name} 님을 강퇴했습니다.` });
        
        if (room.status === 'lobby') {
          delete room.players[targetId];
          room.playerOrder = room.playerOrder.filter(id => id !== targetId);
          io.to(socket.roomCode).emit('update_lobby', Object.values(room.players));
        } else {
          target.isOffline = true;
          if (target.state === 'playing') {
            // 본인 차례일 때만 액션(폴드)을 처리하고, 아닐 때는 상태만 죽은 것(folded)으로 바꿈
            if (room.currentTurnId === target.id) {
              handleAction(room, socket.roomCode, target, { action: 'fold' }, io);
            } else {
              target.state = 'folded';
            }
          }
        }
      }
    }
  });

  // [신규] 채팅 메시지 수신 및 브로드캐스트 (보안 강화 완료)
  socket.on('send_chat', (msg) => {
    const room = rooms[socket.roomCode];
    if (room && room.players[socket.id]) {
      const pName = room.players[socket.id].name;
      
      // [서버 2중 보안] 해킹용 특수 기호를 안전한 문자로 강제 변환합니다.
      const safeMsg = typeof msg === 'string' ? msg.replace(/</g, "&lt;").replace(/>/g, "&gt;") : "";
      
      io.to(socket.roomCode).emit('chat_message', { type: 'chat', name: pName, msg: safeMsg });
    }
  });

  socket.on('rebuy', () => {
    const room = rooms[socket.roomCode];
    if (room && room.players[socket.id]) {
      if (room.status === 'playing' && room.stage < 5) {
        // 예약이 안 되어 있고(0이거나 undefined), 칩이 10000 미만일 때만 1번 예약되도록 변경
        if (!room.players[socket.id].pendingRebuy && room.players[socket.id].chips < 10000) {
            room.players[socket.id].pendingRebuy = 1;
        }
      } else {
        // [새로 추가된 방어막] 칩이 10,000 미만일 때만 리바이(10,000칩 추가)를 허용합니다.
        if (room.players[socket.id].chips < 10000) {
          room.players[socket.id].chips += 10000; 
          room.players[socket.id].rebuyCount += 1;
        }
      }
      io.to(socket.roomCode).emit('update_game_state', getGameState(room));
      io.to(socket.roomCode).emit('chat_message', { type: 'sys', msg: `💸 ${room.players[socket.id].name} 님이 리바이를 요청했습니다.` });
    }
  });

  socket.on('start_game', () => {
    const room = rooms[socket.roomCode];
    if (room && room.players[socket.id].isHost && (room.status === 'lobby' || room.stage === 5)) {
      
      if (!room.blindEndTime) { room.blindLevel = 0; room.blindEndTime = Date.now() + BLIND_DURATION; } 
      else if (Date.now() > room.blindEndTime) {
        room.blindLevel = Math.min(room.blindLevel + 1, BLIND_STRUCTURE.length - 1); room.blindEndTime = Date.now() + BLIND_DURATION;
      }

      Object.values(room.players).forEach(p => {
        if (p.pendingRebuy) {
          p.chips += (10000 * p.pendingRebuy);
          p.rebuyCount += p.pendingRebuy;
          p.pendingRebuy = 0;
        }
        // [봇 디테일 개선] 봇 칩이 기본 참가비(200) 미만으로 떨어지면 리바이시킵니다.
        if (p.isBot && p.chips < 200) { p.chips = 10000; p.rebuyCount++; }
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
      if (!isNextHand) {
        // [자리 배치 버그 수정] 첫 게임 시작 시 방의 전체 좌석표를 완전히 랜덤하게 섞고 고정합니다.
        room.playerOrder.sort(() => Math.random() - 0.5);
        
        // 섞인 진짜 좌석표를 기준으로 참가자 명단을 다시 뽑습니다.
        activeIds.length = 0;
        activeIds.push(...room.playerOrder.filter(id => room.players[id].chips > 0 && !room.players[id].isOffline));
      } else if (isNextHand && room.dealerId) {
        let prevDIdx = activeIds.indexOf(room.dealerId);
        dIdx = prevDIdx !== -1 ? (prevDIdx + 1) % activeIds.length : 0;
      }
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
        
        if (idx === sbIdx) { 
          let cost = Math.min(p.chips, currBlinds.sb); p.chips -= cost; 
          p.currentBet = cost; p.invested = cost; room.pot += cost; p.role = 'SB'; 
          if (p.chips === 0) p.acted = true; 
        } 
        else if (idx === bbIdx) { 
          let cost = Math.min(p.chips, currBlinds.bb); p.chips -= cost; 
          p.currentBet = cost; p.invested = cost; room.pot += cost; p.role = 'BB'; 
          if (p.chips === 0) p.acted = true;
        } 
        else if (idx === dIdx) { p.role = 'D'; }
      });

      io.to(socket.roomCode).emit('game_started', getGameState(room));
      io.to(socket.roomCode).emit('chat_message', { type: 'sys', msg: `📢 새로운 판이 시작되었습니다!` });
      io.to(socket.roomCode).emit('play_sound', 'deal');
      
      if (room.currentTurnId && room.players[room.currentTurnId].isBot) {
        setTimeout(() => { processBotDecision(room, socket.roomCode, room.players[room.currentTurnId], io); }, 1500);
      } else if (room.currentTurnId) {
        io.to(room.currentTurnId).emit('play_sound', 'my_turn');
      }
    }
  });

  socket.on('player_action', (data) => {
    try {
      const room = rooms[socket.roomCode];
      // 방이 삭제되었거나 내 정보가 없으면 아무 액션도 하지 않고 종료(에러 방지)
      if (!room || !room.players[socket.id]) return;
      
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
      results.sort((a, b) => b.profit - a.profit);

      let finalMsg = `🏆 최종 정산 결과 🏆\n\n`;
      const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
      results.forEach((r, idx) => {
        let profitStr = r.profit > 0 ? `+${r.profit.toLocaleString()}` : `${r.profit.toLocaleString()}`;
        finalMsg += `${medals[idx] || '🔹'} [${r.name}]\n  💰 칩: ${r.chips.toLocaleString()} | 💸 리바이: ${r.rebuys}회\n  📈 순수익: ${profitStr}\n\n`;
      });
      io.to(socket.roomCode).emit('system_message', finalMsg);
      io.to(socket.roomCode).emit('chat_message', { type: 'sys', msg: `🛑 게임이 종료되어 로비로 돌아갑니다.` });
      
      room.status = 'lobby'; room.blindLevel = 0; room.blindEndTime = null;
      
      Object.keys(room.players).forEach(key => {
        if(room.players[key].isOffline || room.players[key].isBot) {
          delete room.players[key];
          room.playerOrder = room.playerOrder.filter(id => id !== key);
        } else {
          let p = room.players[key];
          p.chips = 10000; p.rebuyCount = 0; p.pendingRebuy = 0; p.state = 'waiting'; p.cards = []; p.currentBet = 0; p.invested = 0; p.acted = false;
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
      io.to(roomCode).emit('chat_message', { type: 'sys', msg: `🔌 ${player.name} 님의 연결이 끊겼습니다.` });
      if (room.status === 'playing' && player.state === 'playing') player.state = 'folded';

      const onlineHumans = room.playerOrder.filter(id => !room.players[id].isOffline && !room.players[id].isBot);

      if (onlineHumans.length === 0) {
        delete rooms[roomCode]; 
      } else {
        if (wasHost) { player.isHost = false; room.players[onlineHumans[0]].isHost = true; }
        
        // [핵심 수정] 턴인 사람이 나갔을 때 복잡하게 턴을 넘기지 않고, '자동 폴드' 처리하여 메인 시스템(handleAction)에 넘깁니다.
        if (room.status === 'playing' && isMyTurn) {
          handleAction(room, roomCode, player, { action: 'fold' }, io);
        } else {
          if (room.status === 'lobby') io.to(roomCode).emit('update_lobby', Object.values(room.players));
          else io.to(roomCode).emit('update_game_state', getGameState(room));
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => { console.log(`🚀 채팅, 사운드, 강퇴 기능 추가 완료! (포트: ${PORT})`); });