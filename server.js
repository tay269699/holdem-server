// server.js
const express = require('express');
const app = express();
const path = require('path');
const http = require('http').createServer(app);

// [핵심 수정 1] 클라우드 환경을 위한 CORS(웹소켓 통신 보안) 허용
const io = require('socket.io')(http, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

let rooms = {};

const BLIND_STRUCTURE = [
  { sb: 100, bb: 200 }, { sb: 200, bb: 400 }, { sb: 300, bb: 600 },
  { sb: 500, bb: 1000 }, { sb: 1000, bb: 2000 }, { sb: 2000, bb: 4000 }
];
const BLIND_DURATION = 5 * 60 * 1000; 

// [안정성 수정] 절대 경로(path.join)를 사용하여 렌더(리눅스) 환경 에러 방지
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
  const rankValues = { '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10, 'J':11, 'Q':12, 'K':13, 'A':14 };
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
  return { score, handName };
}

function distributePots(room) {
  let activeBettors = Object.values(room.players)
    .filter(p => p.invested > 0)
    .sort((a, b) => a.invested - b.invested);

  let pots = [];
  let previousInvested = 0;

  for (let i = 0; i < activeBettors.length; i++) {
    let p = activeBettors[i];
    let contribution = p.invested - previousInvested;

    if (contribution > 0) {
      let potAmount = 0;
      let eligiblePlayers = [];

      for (let j = i; j < activeBettors.length; j++) {
        potAmount += contribution;
        let player = room.players[activeBettors[j].id];
        if (player.state !== 'folded' && player.state !== 'busted') {
          eligiblePlayers.push(player);
        }
      }

      if (potAmount > 0) pots.push({ amount: potAmount, eligible: eligiblePlayers });
      previousInvested = p.invested;
    }
  }

  let msgs = [];
  pots.forEach((pot, index) => {
    if (pot.eligible.length === 1) {
      let winner = pot.eligible[0];
      winner.chips += pot.amount;
      msgs.push(pots.length > 1 ? `사이드 팟 ${index+1}(${pot.amount}칩): ${winner.name} (단독 획득)` : `총 팟(${pot.amount}칩): ${winner.name} (단독 획득)`);
    } else if (pot.eligible.length > 1) {
      let results = pot.eligible.map(p => {
        let evalResult = evaluateHand(p.cards, room.communityCards);
        return { pRef: p, score: evalResult.score, handName: evalResult.handName };
      });
      results.sort((a, b) => b.score - a.score);
      
      let highestScore = results[0].score;
      let winners = results.filter(r => r.score === highestScore);
      let splitAmount = Math.floor(pot.amount / winners.length);

      winners.forEach(w => { w.pRef.chips += splitAmount; });
      let winnerNames = winners.map(w => w.pRef.name).join(", ");
      let handNames = winners.map(w => w.handName).join(", ");
      
      msgs.push(pots.length > 1 ? `사이드 팟 ${index+1}(${pot.amount}칩): ${winnerNames} 승리 (${handNames})` : `총 팟(${pot.amount}칩): ${winnerNames} 승리 (${handNames})`);
    }
  });
  return msgs;
}

function processShowdown(io, roomCode) {
  const room = rooms[roomCode];
  room.stage = 5; 
  let msgs = distributePots(room);

  let finalMsg = `🔥 쇼다운 결과 🔥\n\n`;
  let commCardsStr = room.communityCards.map(c => c.suit + c.rank).join(', ');
  finalMsg += `🃏 [바닥 카드]: ${commCardsStr || '없음'}\n\n`;

  let activePlayers = room.playerOrder.filter(id => room.players[id].state === 'playing');
  activePlayers.forEach(id => { 
    let p = room.players[id];
    let cardsStr = p.cards.map(c => c.suit + c.rank).join(', ');
    let evalResult = evaluateHand(p.cards, room.communityCards);
    finalMsg += `- ${p.name}: ${evalResult.handName} (${cardsStr})\n`; 
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
  } else {
    processShowdown(io, roomCode);
  }
}

io.on('connection', (socket) => {
  socket.on('join_room', (data) => {
    const roomCode = data.roomCode;
    const playerName = data.playerName;
    
    if (rooms[roomCode]) {
      const isDuplicate = Object.values(rooms[roomCode].players).some(p => p.name === playerName);
      if (isDuplicate) return socket.emit('join_error', '⚠️ 이미 접속 중인 닉네임입니다. 다른 닉네임을 사용해주세요.');
    }

    socket.join(roomCode);
    socket.roomCode = roomCode;

    if (!rooms[roomCode]) {
      rooms[roomCode] = { 
        status: 'lobby', players: {}, playerOrder: [], deck: [],
        dealerId: null, currentTurnId: null, pot: 0, highestBet: 0,
        lastRaiseAmount: 200, minRaise: 200, stage: 0, communityCards: [],
        blindLevel: 0, blindEndTime: null, uncontestedWinner: null
      };
    }

    rooms[roomCode].players[socket.id] = {
      id: socket.id, name: playerName, chips: 10000,
      isHost: rooms[roomCode].playerOrder.length === 0, 
      cards: [], currentBet: 0, invested: 0, state: 'waiting', acted: false, rebuyCount: 0
    };
    rooms[roomCode].playerOrder.push(socket.id);
    
    if (rooms[roomCode].status === 'playing') {
      socket.emit('game_started', getGameState(rooms[roomCode]));
      io.to(roomCode).emit('update_game_state', getGameState(rooms[roomCode]));
    } else {
      io.to(roomCode).emit('update_lobby', Object.values(rooms[roomCode].players));
    }
  });

  socket.on('rebuy', () => {
    const room = rooms[socket.roomCode];
    if (room && room.players[socket.id]) {
      room.players[socket.id].chips += 10000;
      room.players[socket.id].rebuyCount += 1;
      io.to(socket.roomCode).emit('update_game_state', getGameState(room));
    }
  });

  socket.on('start_game', () => {
    const room = rooms[socket.roomCode];
    if (room && room.players[socket.id].isHost && (room.status === 'lobby' || room.stage === 5)) {
      
      if (!room.blindEndTime) { room.blindLevel = 0; room.blindEndTime = Date.now() + BLIND_DURATION; } 
      else if (Date.now() > room.blindEndTime) {
        room.blindLevel = Math.min(room.blindLevel + 1, BLIND_STRUCTURE.length - 1);
        room.blindEndTime = Date.now() + BLIND_DURATION;
      }

      const currBlinds = BLIND_STRUCTURE[room.blindLevel] || BLIND_STRUCTURE[BLIND_STRUCTURE.length - 1];
      const activeIds = room.playerOrder.filter(id => room.players[id].chips > 0);
      if (activeIds.length < 2) return socket.emit('system_message', '칩을 가진 유저가 최소 2명 필요합니다.');

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

      let sbIdx = (dIdx + 1) % activeIds.length;
      let bbIdx = (dIdx + 2) % activeIds.length;
      let utgIdx = (dIdx + 3) % activeIds.length;
      
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
    }
  });

  socket.on('player_action', (data) => {
    try {
      const room = rooms[socket.roomCode];
      if(!room || room.status !== 'playing' || room.currentTurnId !== socket.id) return; 

      const player = room.players[socket.id]; player.acted = true; 

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
        if(cost >= player.chips) { 
          cost = player.chips; 
          raiseAmount = player.currentBet + cost; 
        }
        
        player.chips -= cost; player.currentBet += cost; player.invested += cost; room.pot += cost; 
        
        if (raiseAmount > room.highestBet) {
          let raiseDiff = raiseAmount - room.highestBet;
          if (raiseDiff >= room.lastRaiseAmount) room.lastRaiseAmount = raiseDiff;
          room.highestBet = raiseAmount;
          room.minRaise = room.highestBet + room.lastRaiseAmount;
          
          room.playerOrder.forEach(id => { let p = room.players[id]; if(p.id !== socket.id && p.state === 'playing' && p.chips > 0) p.acted = false; });
        }
      }

      const activePlayers = room.playerOrder.filter(id => room.players[id].state === 'playing');
      
      if (activePlayers.length === 1) {
        const winner = room.players[activePlayers[0]];
        winner.chips += room.pot; room.stage = 5; room.uncontestedWinner = winner.id; 
        setTimeout(() => { io.to(socket.roomCode).emit('system_message', `🎉 전원 폴드!\n[${winner.name}]님이 패를 숨긴 채 ${room.pot}칩을 가져갑니다.`); }, 500);
        io.to(socket.roomCode).emit('update_game_state', getGameState(room));
        return;
      }

      const isRoundOver = activePlayers.every(id => { let p = room.players[id]; return p.acted && (p.currentBet === room.highestBet || p.chips === 0); });

      if (isRoundOver) {
        const playersWithChips = activePlayers.filter(id => room.players[id].chips > 0);

        if (playersWithChips.length <= 1 && room.stage < 4) {
            room.currentTurnId = null; 
            processAllInShowdown(io, socket.roomCode); 
            return;
        }

        if (room.stage < 4) {
          room.stage++; 
          room.highestBet = 0; 
          const currBB = (BLIND_STRUCTURE[room.blindLevel] || BLIND_STRUCTURE[BLIND_STRUCTURE.length - 1]).bb;
          room.lastRaiseAmount = currBB; 
          room.minRaise = currBB; 

          activePlayers.forEach(id => { room.players[id].currentBet = 0; if (room.players[id].chips > 0) room.players[id].acted = false; });

          if (room.stage === 1) { room.communityCards.push(room.deck.pop(), room.deck.pop(), room.deck.pop()); } 
          else if (room.stage === 2 || room.stage === 3) { room.communityCards.push(room.deck.pop()); } 
          else if (room.stage === 4) { 
            processShowdown(io, socket.roomCode);
            return;
          }
          findNextTurn(room, activePlayers, true);
        }
      } else { 
        findNextTurn(room, activePlayers, false); 
      }

      io.to(socket.roomCode).emit('update_game_state', getGameState(room));
    } catch (e) {
      console.error("서버 턴 처리 중 오류 방어:", e);
    }
  });

  socket.on('show_cards', () => {
    const room = rooms[socket.roomCode];
    if (room && room.stage === 5 && room.uncontestedWinner === socket.id) {
      const p = room.players[socket.id];
      const cardsStr = p.cards.map(c => c.suit + c.rank).join(', ');
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
      const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
      
      results.forEach((r, idx) => {
        let profitStr = r.profit > 0 ? `+${r.profit.toLocaleString()}` : `${r.profit.toLocaleString()}`;
        let medal = medals[idx] || '🔹';
        finalMsg += `${medal} [${r.name}]\n`;
        finalMsg += `  💰 최종 칩: ${r.chips.toLocaleString()}\n`;
        finalMsg += `  💸 리바이: ${r.rebuys}회\n`;
        finalMsg += `  📈 순수익: ${profitStr} 칩\n\n`;
      });

      io.to(socket.roomCode).emit('system_message', finalMsg);
      
      room.status = 'lobby';
      room.blindLevel = 0;
      room.blindEndTime = null;
      
      Object.values(room.players).forEach(p => {
        p.chips = 10000; 
        p.rebuyCount = 0;
        p.state = 'waiting';
        p.cards = [];
        p.currentBet = 0;
        p.invested = 0;
        p.acted = false;
      });
      
      io.to(socket.roomCode).emit('update_lobby', Object.values(room.players));
    }
  });

  socket.on('disconnect', () => {
    const roomCode = socket.roomCode;
    const room = rooms[roomCode];
    if (roomCode && room && room.players[socket.id]) {
      const wasHost = room.players[socket.id].isHost;
      const isMyTurn = (room.currentTurnId === socket.id);
      
      delete room.players[socket.id];
      room.playerOrder = room.playerOrder.filter(id => id !== socket.id);

      if (room.playerOrder.length === 0) {
        delete rooms[roomCode]; 
      } else {
        if (wasHost) { room.players[room.playerOrder[0]].isHost = true; }
        if (room.status === 'playing' && isMyTurn) {
          const activePlayers = room.playerOrder.filter(id => room.players[id].state === 'playing');
          findNextTurn(room, activePlayers, false);
        }
        if (room.status === 'lobby') io.to(roomCode).emit('update_lobby', Object.values(room.players));
        else io.to(roomCode).emit('update_game_state', getGameState(room));
      }
    }
  });
});

function findNextTurn(room, activePlayers, isNewStage) {
  if (activePlayers.length === 0) { room.currentTurnId = null; return; }

  let turnIdx = 0;
  if (isNewStage) {
    let dealerIdx = activePlayers.indexOf(room.dealerId);
    if (dealerIdx === -1) dealerIdx = 0;
    turnIdx = dealerIdx; 
  } else {
    turnIdx = activePlayers.indexOf(room.currentTurnId);
    if (turnIdx === -1) turnIdx = 0;
  }

  let nextFound = false;
  for(let i=0; i<activePlayers.length; i++) {
    turnIdx = (turnIdx + 1) % activePlayers.length;
    let nextP = room.players[activePlayers[turnIdx]];
    if (nextP.state === 'playing' && nextP.chips > 0) { room.currentTurnId = nextP.id; nextFound = true; break; }
  }
  if(!nextFound) room.currentTurnId = null; 
}

function getGameState(room) {
  return {
    players: room.players, pot: room.pot, currentTurnId: room.currentTurnId, highestBet: room.highestBet, 
    minRaise: room.minRaise, communityCards: room.communityCards, stage: room.stage, 
    blindLevel: room.blindLevel, blindEndTime: room.blindEndTime, blinds: BLIND_STRUCTURE,
    uncontestedWinner: room.uncontestedWinner
  };
}

const PORT = process.env.PORT || 3000;
// [핵심 수정 2] Render 등 외부 클라우드 접속을 허용하기 위한 '0.0.0.0' 호스트 바인딩
http.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 홀덤 서버 클라우드 엔진 가동 완료! (포트: ${PORT})`);
});