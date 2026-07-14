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

// 기존 배열(BLIND_STRUCTURE)을 삭제하고 아래 코드로 바꿉니다.
const BLIND_DURATION = 5 * 60 * 1000; 

// 🌟 무한 2배수 계산 함수 (level 0이면 100/200, level 1이면 200/400 ... 무한대)
function getBlinds(level) {
  return { 
    sb: 100 * Math.pow(2, level), 
    bb: 200 * Math.pow(2, level) 
  };
} 

const rankValues = { '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10, 'J':11, 'Q':12, 'K':13, 'A':14 };

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

// 👇 이 한 줄을 추가하세요. (화면에서 10분마다 여기로 똑똑 노크를 해서 서버가 잠들지 않게 깨웁니다)
app.get('/ping', (req, res) => { res.send('pong'); });

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
  
  // 1단계: 기존 방식대로 일단 금액 구간별로 팟을 잘게 쪼갭니다.
  let rawPots = []; let previousInvested = 0;
  for (let i = 0; i < activeBettors.length; i++) {
    let p = activeBettors[i]; let contribution = p.invested - previousInvested;
    if (contribution > 0) {
      let potAmount = 0; let eligiblePlayers = [];
      for (let j = i; j < activeBettors.length; j++) {
        potAmount += contribution; let player = room.players[activeBettors[j].id];
        if (player.state !== 'folded' && player.state !== 'busted') eligiblePlayers.push(player);
      }
      if (potAmount > 0) rawPots.push({ amount: potAmount, eligible: eligiblePlayers });
      previousInvested = p.invested;
    }
  }

  // 2단계: (🔥추가된 핵심 로직) 먹을 수 있는 자격자 명단이 똑같은 팟들은 하나의 팟으로 합칩니다!
  let pots = [];
  rawPots.forEach(currentPot => {
    if (pots.length === 0) {
      pots.push(currentPot);
    } else {
      let lastPot = pots[pots.length - 1];
      // 자격이 있는 사람들의 ID를 문자로 이어서 비교합니다.
      let lastIds = lastPot.eligible.map(p => p.id).sort().join(',');
      let currentIds = currentPot.eligible.map(p => p.id).sort().join(',');
      
      if (lastIds === currentIds) {
        // 먹을 사람이 완전히 똑같으면 굳이 사이드팟으로 쪼개지 않고 돈을 합칩니다.
        lastPot.amount += currentPot.amount; 
      } else {
        // 누군가 올인해서 먹을 자격자가 달라졌을 때만 진짜 사이드 팟으로 분리합니다.
        pots.push(currentPot); 
      }
    }
  });

  // 3단계: 화면에 텍스트로 출력하는 로직 (기존과 동일)
  let msgs = [];
  pots.forEach((pot, index) => {
    if (pot.eligible.length === 1) {
      let winner = pot.eligible[0]; winner.chips += pot.amount;
      msgs.push(pots.length > 1 ? `💰 사이드 팟 ${index+1} (${pot.amount.toLocaleString()}칩)\n 👑 <b style="color:#2ecc71; font-size:18px;">승자: ${winner.name}</b>` : `💰 총 팟 (${pot.amount.toLocaleString()}칩)\n 👑 <b style="color:#2ecc71; font-size:18px;">승자: ${winner.name}</b>`);
    } else if (pot.eligible.length > 1) {
      let results = pot.eligible.map(p => {
        let evalResult = evaluateHand(p.cards, room.communityCards);
        return { pRef: p, score: evalResult.score, handName: evalResult.handName };
      });
      results.sort((a, b) => b.score - a.score);
      let highestScore = results[0].score; let winners = results.filter(r => r.score === highestScore);
      let splitAmount = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount % winners.length; 
      
      winners.forEach((w, idx) => { 
        w.pRef.chips += splitAmount; 
        if (idx === 0) w.pRef.chips += remainder; 
      });
      
      if (winners.length === 1) {
        msgs.push(pots.length > 1 ? `💰 사이드 팟 ${index+1} (${pot.amount.toLocaleString()}칩)\n 👑 <b style="color:#2ecc71; font-size:18px;">승자: ${winners[0].pRef.name}</b> (${winners[0].handName})` : `💰 총 팟 (${pot.amount.toLocaleString()}칩)\n 👑 <b style="color:#2ecc71; font-size:18px;">승자: ${winners[0].pRef.name}</b> (${winners[0].handName})`);
      } else {
        msgs.push(pots.length > 1 ? `💰 사이드 팟 ${index+1} (${pot.amount.toLocaleString()}칩)\n 🤝 <b style="color:#3498db; font-size:18px;">공동 승자: ${winners.map(w=>w.pRef.name).join(", ")}</b> (${winners[0].handName})` : `💰 총 팟 (${pot.amount.toLocaleString()}칩)\n 🤝 <b style="color:#3498db; font-size:18px;">공동 승자: ${winners.map(w=>w.pRef.name).join(", ")}</b> (${winners[0].handName})`);
      }
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
  finalMsg += `\n🎉 [팟 분배 결과]\n` + msgs.join('\n\n'); // 간격을 띄워서 더 읽기 쉽게 만듦
  broadcastGameState(io, roomCode, room);
  
  // 👇 채팅 로그에도 결과 요약 전송 (HTML 태그를 떼어내고 깔끔하게 텍스트만 전송)
  let logMsg = msgs.join(' / ').replace(/<[^>]*>?/gm, '').replace(/\n/g, ' '); 
  io.to(roomCode).emit('chat_message', { type: 'sys', msg: `🏆 ${logMsg}` });

  setTimeout(() => { io.to(roomCode).emit('system_message', finalMsg); }, 1500);
}

function processAllInShowdown(io, roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  if (room.stage < 4) {
    room.stage++; room.highestBet = 0; room.lastRaiseAmount = 0;
    if (room.stage === 1) { room.communityCards.push(room.deck.pop(), room.deck.pop(), room.deck.pop()); } 
    else if (room.stage === 2 || room.stage === 3) { room.communityCards.push(room.deck.pop()); }
    broadcastGameState(io, roomCode, room);
    io.to(roomCode).emit('play_sound', 'deal'); // 사운드 트리거
    setTimeout(() => processAllInShowdown(io, roomCode), 1500);
  } else { processShowdown(io, roomCode); }
}

function handleAction(room, roomCode, player, data, io) {
  // 👇 [보안 패치] stage === 5 (결과창) 조건을 추가하여 무한 칩 복사 해킹과 타이머 꼬임을 완벽히 차단합니다.
  if(!room || room.status !== 'playing' || room.stage === 5 || !player || room.currentTurnId !== player.id || !data) return; 
  
  // 유저가 버튼을 눌러 액션을 취하면 째깍거리던 타이머를 즉시 정지시킵니다
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  
  // 🌟 [수정 1] 도장을 찍기 전에, 원래 이 사람이 행동을 했었는지 먼저 기억해둡니다!
  const hasAlreadyActed = player.acted;

  player.acted = true; 
  let actionLog = '';

  if (data.action === 'call') {
    let callAmount = room.highestBet - player.currentBet;
    if(callAmount > 0) {
      if(callAmount > player.chips) callAmount = player.chips; 
      player.chips -= callAmount; player.currentBet += callAmount; player.invested += callAmount; room.pot += callAmount;
      actionLog = `[${player.name}] 님이 콜을 받았습니다. (${callAmount.toLocaleString()}칩)`;
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

    // 🌟 [수정 2] 방금 true로 바뀐 player.acted가 아니라, 아까 기억해둔 hasAlreadyActed를 검사합니다!
    if (hasAlreadyActed) {
      return; 
    }

    let raiseAmount = parseInt(data.amount);
    let maxPossibleBet = player.currentBet + player.chips;
    
    // 👇 이 부분이 변경되었습니다! (음수 값이 들어오면 강제로 최소 베팅금으로 바꿔버림)
    if (isNaN(raiseAmount) || raiseAmount <= 0) raiseAmount = room.minRaise; 
    if (raiseAmount < room.minRaise && raiseAmount !== maxPossibleBet) { raiseAmount = room.minRaise; }

    let cost = raiseAmount - player.currentBet;
    if(cost >= player.chips) { 
      cost = player.chips; 
      raiseAmount = player.currentBet + cost; 
    }
    
    player.chips -= cost; player.currentBet += cost; player.invested += cost; room.pot += cost; 
    
    let isAllIn = player.chips === 0;
    actionLog = isAllIn ? `🔥 [${player.name}] 님이 올인했습니다! (${cost.toLocaleString()}칩)` : `📈 [${player.name}] 님이 레이즈했습니다. (총 ${raiseAmount.toLocaleString()}칩)`;
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
    setTimeout(() => { 
      // 👇 모달창 강조
      io.to(roomCode).emit('system_message', `🎉 전원 폴드!\n👑 <b style="color:#2ecc71; font-size:18px;">승자: ${winner.name}</b>\n\n패를 숨긴 채 ${room.pot.toLocaleString()}칩을 가져갑니다.`); 
      // 👇 채팅창 로그 전송
      io.to(roomCode).emit('chat_message', { type: 'sys', msg: `🏆 전원 폴드로 [${winner.name}] 님이 ${room.pot.toLocaleString()}칩 획득!` });
    }, 500);
    broadcastGameState(io, roomCode, room);
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
    
    // 👇 방금 낸 칩 소리가 잘 들리도록 일단 현재 상태(돈 낸 상태)만 화면에 먼저 쏴줍니다.
    broadcastGameState(io, roomCode, room);
    
    if (room.stage < 4) {
      // 👇 🔥 [버그 수정 핵심] 1초 대기열에 들어가기 전에, 즉시 턴을 박탈하여 중복 클릭 공격을 막습니다!
      room.currentTurnId = null;
      
      // 👇 1초(1000ms) 딜레이를 줍니다.
      setTimeout(() => {
        room.stage++; room.highestBet = 0; 
        // 🌟 상한선 없이 함수에서 현재 레벨의 빅 블라인드 값을 바로 가져옴
        const currBB = getBlinds(room.blindLevel).bb;
        room.lastRaiseAmount = currBB; room.minRaise = currBB; 
        activePlayers.forEach(id => { room.players[id].currentBet = 0; if (room.players[id].chips > 0) room.players[id].acted = false; });
        
        if (room.stage === 1) { room.communityCards.push(room.deck.pop(), room.deck.pop(), room.deck.pop()); } 
        else if (room.stage === 2 || room.stage === 3) { room.communityCards.push(room.deck.pop()); } 
        else if (room.stage === 4) { processShowdown(io, roomCode); return; }
        
        io.to(roomCode).emit('play_sound', 'deal'); // 1초 뒤에 카드 깔리는 소리 재생
        findNextTurn(room, activePlayers, true, roomCode, io);
        
        // 딜레이 후에 변한 상태(새 카드가 깔린 상태)를 다시 화면에 쏴줍니다.
        broadcastGameState(io, roomCode, room); 
      }, 1000); 
      
      return; // 중요: 아래에 있는 원래의 broadcastGameState가 즉시 실행되지 않도록 여기서 함수를 끝냅니다.
    }
  } else { 
    findNextTurn(room, activePlayers, false, roomCode, io); 
  }

  broadcastGameState(io, roomCode, room);
}

function processBotDecision(room, roomCode, bot, io) {
  if (room.currentTurnId !== bot.id || room.status !== 'playing') return;

  const callAmount = room.highestBet - bot.currentBet;
  let action = 'fold'; let raiseAmt = 0;
  let rand = Math.random(); 

  let bluffProb = 1.0; 
  let foldProb = 1.0;  
  let raiseAggressiveness = 0.5; 

  const aggroKeywords = ['올인하는', '뻥카치는', '대담한', '건방진', '화난', '성급한', '허세부리는', '무서운'];
  const tightKeywords = ['소심한', '눈치보는', '쫄보인', '신중한', '계산적인', '수줍은', '예민한', '초조한'];

  let isAggro = aggroKeywords.some(kw => bot.name.includes(kw));
  let isTight = tightKeywords.some(kw => bot.name.includes(kw));

  // 1. [멘탈 붕괴 시스템]
  if (room.stage === 0 && bot.recentlyLostBig) {
    bot.recentlyLostBig = false; 
    let tiltChance = isAggro ? 0.6 : (isTight ? 0.15 : 0.3);
    if (Math.random() < tiltChance) {
      bot.tiltRounds = isAggro ? 4 : (isTight ? 2 : 3);
      io.to(roomCode).emit('chat_message', { type: 'log', msg: `💢 [${bot.name}] 님이 방금 판의 충격으로 평정심을 잃은 것 같습니다...` });
    }
  }

  if (isAggro) { bluffProb = 2.5; foldProb = 0.5; raiseAggressiveness = 0.8; } 
  else if (isTight) { bluffProb = 0.2; foldProb = 1.5; raiseAggressiveness = 0.3; }

  if (bot.tiltRounds > 0) {
     let tiltIntensity = isAggro ? 2.0 : (isTight ? 1.2 : 1.5);
     bluffProb *= tiltIntensity; foldProb /= tiltIntensity; raiseAggressiveness *= tiltIntensity;
     if (foldProb < 0.2) foldProb = 0.2; 
  }
  
  // 🌟 2. [신규: 공포 시스템] 상대적 빈곤감 인지
  let otherMaxChips = 0;
  room.playerOrder.forEach(id => {
    let p = room.players[id];
    if (p.id !== bot.id && p.state === 'playing' && p.chips > otherMaxChips) {
      otherMaxChips = p.chips;
    }
  });

  // 나보다 2배 이상 돈이 많은 압도적 부자가 있고, 내 전 재산의 15% 이상을 베팅해야 한다면 '공포'를 느낌
  let amIFacingBully = (otherMaxChips >= bot.chips * 2) && (callAmount >= bot.chips * 0.15);
  
  if (amIFacingBully) {
    // 쫄보는 2배 더 잘 도망가고, 상남자는 자존심 때문에 전혀 안 쫄고(1.0), 일반 봇은 1.3배 더 잘 도망감
    let fearFactor = isTight ? 2.0 : (isAggro ? 1.0 : 1.3);
    foldProb *= fearFactor; 
  }

  // 🌟 [신규 봇 지능 업그레이드 1] 포지션(자리) 인지 시스템
  let activePlayers = room.playerOrder.filter(id => room.players[id].state === 'playing');
  // 💡 [기억상실 버그 수정] 딜러가 죽어도 자리를 안 까먹게, 변하지 않는 '원래 좌석표(playerOrder)'를 기준으로 거리를 계산!
  let myPosIdx = room.playerOrder.indexOf(bot.id);
  let dealerPosIdx = room.playerOrder.indexOf(room.dealerId);
  let distance = (myPosIdx - dealerPosIdx + room.playerOrder.length) % room.playerOrder.length;
  
  // 딜러 버튼(가장 늦게 행동하는 좋은 자리)에 가까울수록 블러핑을 자주 하고, 덜 도망감
  if (distance === activePlayers.length - 1 || distance === 0) {
    bluffProb *= 1.3; foldProb *= 0.8; 
  } else if (distance === 1 || distance === 2) {
    // 얼리 포지션 (가장 먼저 행동해야 하는 나쁜 자리)에서는 몸을 사림
    bluffProb *= 0.7; foldProb *= 1.3; 
  }

  // 🌟 [신규 봇 지능 업그레이드 2] 바닥 카드 위험도 & 약한 키커 인지
  if (room.stage > 0) {
    let boardSuits = { '♠':0, '♥':0, '♦':0, '♣':0 };
    room.communityCards.forEach(c => boardSuits[c.suit]++);
    let maxSuit = Math.max(...Object.values(boardSuits));
    
    let evalResult = evaluateHand(bot.cards, room.communityCards);
    
    // ① 위험한 보드 감지: 바닥에 같은 무늬가 3장 이상 깔렸는데 내 패가 플러시(레벨 5) 미만이면 위험을 감지하고 도망갈 확률을 대폭 올림
    if (maxSuit >= 3 && evalResult.level < 5) {
      foldProb *= 1.8; 
    }
    
    // ② 약한 원페어 인지: 족보가 '원페어(레벨 1)'이긴 하지만, 숫자가 10 이하라면 누군가 세게 베팅했을 때 쉽게 죽음
    if (evalResult.level === 1) { 
      let myPairVal = Math.max(rankValues[bot.cards[0].rank], rankValues[bot.cards[1].rank]);
      if (myPairVal <= 10) { 
        if (callAmount > room.highestBet * 0.5) foldProb *= 1.5;
      }
    }
  }

  // 3. [매몰 비용 & 팟 오즈]
  let potOdds = callAmount > 0 ? callAmount / (room.pot + callAmount) : 0;
  let totalWealth = bot.chips + bot.invested;
  let investmentRatio = totalWealth > 0 ? bot.invested / totalWealth : 0;
  let isCommitted = investmentRatio >= 0.5;

  if (isCommitted) { foldProb *= 0.1; } 
  else if (potOdds > 0 && potOdds < 0.2) { foldProb *= 0.5; }

  function getDynamicRaise() {
    let potSize = room.pot;
    let baseRaise = callAmount + (potSize * raiseAggressiveness * (0.8 + Math.random() * 0.4));
    let finalRaise = Math.floor(baseRaise / 100) * 100;
    return Math.max(room.minRaise, finalRaise);
  }

  // --- 기존 행동 결정 로직 ---
  // --- 기존 행동 결정 로직 ---
  if (room.stage === 0) {
    let v1 = rankValues[bot.cards[0].rank]; let v2 = rankValues[bot.cards[1].rank];
    let maxV = Math.max(v1, v2); let minV = Math.min(v1, v2);
    let isPremium = (v1 === v2 && v1 >= 10) || (maxV >= 13 && minV >= 11); 
    
    // 🌟 삭제된 배열 대신, 새롭게 만든 getBlinds() 함수에서 빅 블라인드 값을 가져옵니다!
    let bbAmt = getBlinds(room.blindLevel).bb;

    if (callAmount > 0) {
      if (isPremium) { 
        action = rand < 0.8 ? 'raise' : 'call'; 
        // 🌟 수정 1: 프리플랍 괴물 패는 기존 팟 비례가 아니라 BB의 3~5배로 세게 때림!
        let bbMultiplier = 2 + Math.floor(Math.random() * 3); // 2, 3, 4배 추가
        raiseAmt = room.highestBet + (bbAmt * bbMultiplier); 
      } 
      else if (v1 === v2 || maxV >= 10) { 
        // 🌟 수정 2: 아무도 레이즈 안 한 상태(highestBet == bbAmt)면 묻어가지 않고 40% 확률로 오픈 레이즈 시도!
        if (room.highestBet === bbAmt && rand < (0.4 * raiseAggressiveness * 2)) {
          action = 'raise';
          raiseAmt = room.highestBet + (bbAmt * 2); // 기본 3BB 레이즈
        } else {
          action = 'call'; 
          // 💡 [프리플랍 ATM 버그 수정] K, Q, J가 있어도 짝꿍 패(키커)가 8 이하라면 60% 확률로 얌전히 폴드!
          if (v1 !== v2 && minV <= 8 && callAmount > 0 && rand < (0.6 * foldProb)) {
            action = 'fold'; 
          }
          // 기존 거액 베팅 방어 로직 유지
          if (callAmount >= bot.chips * (0.3 / foldProb) && rand < (0.8 * foldProb)) action = 'fold'; 
        }
      } 
      else { 
        action = rand < (0.05 * bluffProb) ? 'raise' : 'fold'; 
        raiseAmt = room.highestBet + (bbAmt * 2); 
      }
    } else { // 자신이 BB(빅블라인드) 위치이거나 앞서 모두 폴드했을 때
      if (isPremium) { action = 'raise'; raiseAmt = bbAmt * (3 + Math.floor(Math.random() * 3)); } 
      else if (v1 === v2 || maxV >= 10) { action = rand < 0.5 ? 'raise' : 'call'; raiseAmt = bbAmt * 3; } 
      else { action = rand < (0.1 * bluffProb) ? 'raise' : 'call'; raiseAmt = bbAmt * 2; }
    }
    
    // 레이즈 금액을 100 단위로 깔끔하게 절사
    raiseAmt = Math.floor(raiseAmt / 100) * 100;
    
  } else { 
    // [플랍 이후 로직은 기존과 완전히 동일하게 유지]
    let evalResult = evaluateHand(bot.cards, room.communityCards);
// ... 생략 (이후 코드는 건드리지 않음) ...
    if (evalResult.level >= 3) { 
      // 💡 [버그 수정] 내 패가 아무리 좋아도(트리플, 스트레이트) 바닥에 같은 무늬가 4장이면 브레이크를 밟아야 함!
      let boardSuits = { '♠':0, '♥':0, '♦':0, '♣':0 };
      room.communityCards.forEach(c => boardSuits[c.suit]++);
      let maxBoardSuit = Math.max(...Object.values(boardSuits));

      if (maxBoardSuit >= 4 && evalResult.level < 5) {
        // 바닥에 플러시 위협이 있는데 난 플러시가 아니면, 무지성 레이즈를 포기하고 콜만 하거나 도망감!
        action = rand < (0.4 * foldProb) ? 'fold' : 'call';
      } else {
        action = 'raise'; raiseAmt = getDynamicRaise(); 
      }
    } 
    else if (evalResult.level >= 1) { 
      if (callAmount === 0) { action = rand < 0.6 ? 'raise' : 'call'; raiseAmt = getDynamicRaise() * 0.5; } 
      else {
        // 👇 베팅액이 적더라도, 공포 수치나 패가 약해서 foldProb가 높으면 도망갈 수 있게 수정!
        if (callAmount <= bot.chips * 0.5) {
          if (rand < (0.2 * foldProb)) action = 'fold'; // 추가된 폴드(도망) 로직
          else action = rand < 0.2 ? 'raise' : 'call'; 
        }
        else {
          action = rand < (0.7 * foldProb) ? 'fold' : 'call'; 
        }
      }
    }
  }

  // 4. [빅 스택 불리 시스템] 
  let isBully = (otherMaxChips > 0) && (bot.chips >= otherMaxChips * 2);
  let isDecentHand = false;
  if (room.stage === 0) {
    let maxV = Math.max(rankValues[bot.cards[0].rank], rankValues[bot.cards[1].rank]);
    isDecentHand = (bot.cards[0].rank === bot.cards[1].rank) || (maxV >= 11);
  } else {
    let evalResult = evaluateHand(bot.cards, room.communityCards);
    isDecentHand = evalResult.level >= 1; 
  }

  // 60% 확률로 상대를 찍어누름 (무조건 발동 아님!)
  if (isBully && isDecentHand && action === 'call') {
    if (Math.random() < 0.6) {
      action = 'raise';
      raiseAmt = getDynamicRaise() * 1.5; 
    }
  }

  // 🤑 [신규 추가: 밸류 베팅 & 핸드 프로텍션 (강한 패 뻥튀기)]
  if (room.stage > 0 && action === 'raise') {
    let finalEval = evaluateHand(bot.cards, room.communityCards);
    
    // 1티어: 진짜 괴물 패 (플러시~스트레이트 플러시, 레벨 5 이상)
    // -> 80%의 높은 확률로 자비 없이 레이즈 금액을 1.5배~2배 뻥튀기
    if (finalEval.level >= 5) {
      if (Math.random() < 0.8) {
        let greedyMultiplier = 1.5 + (Math.random() * 0.5);
        raiseAmt = Math.floor(raiseAmt * greedyMultiplier / 100) * 100;
      }
    }
    // 2티어: 적당히 강하고 거친 패 (투페어~스트레이트, 레벨 2~4)
    // -> 상대가 못 따라오게 압박하는 핸드 프로텍션 베팅!
    else if (finalEval.level >= 2 && finalEval.level <= 4) {
      // 상남자(isAggro) 봇이거나 멘붕(tiltRounds > 0) 상태면 60% 확률로 거칠게 나옴. 쫄보는 20% 확률.
      let pressureChance = (isAggro || bot.tiltRounds > 0) ? 0.6 : (isTight ? 0.2 : 0.35);
      
      if (Math.random() < pressureChance) {
        let pressureMultiplier = 1.2 + (Math.random() * 0.4); // 1.2배 ~ 1.6배 압박
        raiseAmt = Math.floor(raiseAmt * pressureMultiplier / 100) * 100;
      }
    }
  }

  // 🌟 [순서 조정 1: 블러핑 라인] - 제일 먼저 뻥카를 칠지 말지 가볍게 결정합니다.
  // [휴리스틱 4] 삥뜯기 (블라인드 스틸)
  if (room.stage === 0 && room.highestBet === getBlinds(room.blindLevel).bb && action !== 'raise') {
    if (typeof distance !== 'undefined' && (distance === activePlayers.length - 1 || distance === activePlayers.length - 2)) {
      if (Math.random() < 0.5) { action = 'raise'; raiseAmt = getBlinds(room.blindLevel).bb * 2.5; }
    }
  }

  // [휴리스틱 5] 기선제압 뻥카 (C-Bet)
  if (room.stage === 1 && callAmount === 0 && action !== 'raise') {
    if (isAggro && Math.random() < 0.4) {
      action = 'raise'; raiseAmt = Math.floor(room.pot * 0.5 / 100) * 100; raiseAmt = Math.max(room.minRaise, raiseAmt);
    }
  }

  // 🌟 [순서 조정 2: 패 기반 전략 라인] - 내 패 상태에 따른 전술을 짭니다.
  // [수정된 휴리스틱 1] 내 카드에 '그 무늬'가 확실히 있을 때만 쫓아가기!
  if (room.stage === 1 || room.stage === 2) { 
    let suitsCount = { '♠':0, '♥':0, '♦':0, '♣':0 };
    bot.cards.concat(room.communityCards).forEach(c => suitsCount[c.suit]++);
    let targetSuit = Object.keys(suitsCount).find(s => suitsCount[s] === 4);
    
    // 💡 [버그 수정] 바닥에 깔린 4장의 무늬와 똑같은 무늬가 '내 손(bot.cards)'에 최소 1장 이상 있어야만 진짜 드로우!
    let hasMySuit = targetSuit && (bot.cards[0].suit === targetSuit || bot.cards[1].suit === targetSuit);

    if (hasMySuit && callAmount > 0 && callAmount < bot.chips * 0.4 && action !== 'raise') {
      action = 'call'; foldProb = 0; 
    }
  }

  // [휴리스틱 2] 함정 파기 (Check-Raise 트랩)
  if (callAmount === 0 && room.stage > 0) {
    let finalEval = evaluateHand(bot.cards, room.communityCards);
    
    // 💡 내 뒤에 아직 행동을 안 한 플레이어가 몇 명인지 직접 세어봅니다.
    let unactedPlayers = activePlayers.filter(id => id !== bot.id && !room.players[id].acted);
    let amILastToAct = (unactedPlayers.length === 0);

    // 내가 가장 마지막 순서가 아닐 때(!amILastToAct)만 함정을 팜!
    if (finalEval.level >= 4 && action === 'raise' && !amILastToAct) {
      if (Math.random() < 0.3) { action = 'call'; } // 레이즈를 체크로 바꿈 (함정)
    }
  }

  // 🌟 [순서 조정 3: 생존 및 수비 라인] - 목숨이 걸린 결정이므로 이전 로직을 다 엎어버릴 권한이 있습니다.
  // [휴리스틱 3] 숏 스택 푸시 오어 폴드 (상남자 올인)
  let currentBB = getBlinds(room.blindLevel).bb;
  if (bot.chips > 0 && bot.chips <= currentBB * 10) {
    if (action === 'raise' || (action === 'call' && callAmount > 0)) {
      action = 'raise'; raiseAmt = bot.chips + bot.currentBet; // 찔끔 베팅을 무조건 전재산 올인으로 덮어씀!
    }
  }

  // [수비자 휴리스틱] "저 녀석 찐이다!" (극강의 베팅 인정하기)
  if (callAmount > 0 && room.stage > 0 && action !== 'raise') { // 반격(레이즈/올인)을 안 했을 때만 쫄기
    let finalEval = evaluateHand(bot.cards, room.communityCards);
    let originalPot = room.pot - callAmount; 
    let isPainfulAmount = (callAmount >= bot.chips * 0.1) || (callAmount >= currentBB * 3);

    if (callAmount >= originalPot * 0.8 && isPainfulAmount) {
      if (finalEval.level >= 1 && finalEval.level <= 2 && bot.tiltRounds === 0 && !isAggro) {
        if (Math.random() < 0.85) {
          action = 'fold';
          io.to(roomCode).emit('chat_message', { type: 'log', msg: `💦 [${bot.name}] 님이 상대의 거대한 베팅에 기가 눌려 패를 던집니다.` });
        }
      }
    }
  }

  // [수정된 휴리스틱 6] 의심병 발동 (부자 봇 호구화 방지)
  if (room.stage === 3 && callAmount > 0 && action === 'fold') { 
    let finalEval = evaluateHand(bot.cards, room.communityCards);
    
    // 💡 [버그 수정] 내 남은 재산 기준이 아니라, "내가 방어할 금액 대비 판돈(팟)이 3배 이상 커서 먹음직스러울 때" 의심 발동!
    if (finalEval.level >= 1 && room.pot >= callAmount * 3) {
      if (Math.random() < 0.3) { 
        action = 'call'; foldProb = 0; 
        io.to(roomCode).emit('chat_message', { type: 'log', msg: `🤔 [${bot.name}] 님이 의심스러운 눈빛으로 콜을 받습니다...` });
      }
    }
  }

  // --- 기존의 보정 로직 ---
  if (action === 'raise' && raiseAmt >= bot.chips) { raiseAmt = bot.chips + bot.currentBet; }
  if (action === 'raise' && raiseAmt < room.minRaise) { raiseAmt = room.minRaise; } 
  if (action === 'fold' && callAmount === 0) { action = 'call'; } 
  if (action === 'raise' && bot.acted) { action = 'call'; } 
  if (action === 'fold' && isCommitted) { action = 'call'; } 

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
    const expectedTurnId = room.currentTurnId;
    setTimeout(() => {
      if (rooms[roomCode] === room && room.currentTurnId === expectedTurnId) {
        let bot = room.players[room.currentTurnId];
        if (bot && bot.isBot) processBotDecision(room, roomCode, bot, io);
      }
    }, 1500 + Math.random() * 1000);
  } else if (room.currentTurnId) {
    io.to(room.currentTurnId).emit('play_sound', 'my_turn');
    
    // [신규] 유저 턴 시작! 20초 제한 타이머 카운트다운
    const expectedTurnId = room.currentTurnId;
    room.turnStartTime = Date.now();
    if (room.turnTimer) clearTimeout(room.turnTimer);
    
    room.turnTimer = setTimeout(() => {
          if (rooms[roomCode] === room && room.currentTurnId === expectedTurnId) {
            let p = room.players[expectedTurnId];
            if (!p) { 
              room.currentTurnId = null; 
              findNextTurn(room, room.playerOrder.filter(id => room.players[id].state === 'playing' && !room.players[id].isOffline), false, roomCode, io);
              broadcastGameState(io, roomCode, room);
              return; 
            }
            
            let callAmount = Math.max(0, (room.highestBet || 0) - (p.currentBet || 0)); // 🛡️ 금액 오류(음수) 방지
            
            // 시간 초과 시 낼 돈이 없으면 체크, 낼 돈이 있으면 폴드 강제 처리
            let timeoutAction = callAmount === 0 ? 'call' : 'fold';
            
            try {
              handleAction(room, roomCode, p, { action: timeoutAction }, io);
              io.to(roomCode).emit('chat_message', { type: 'sys', msg: `⏰ [${p.name}] 님이 시간 초과로 자동 진행(폴드/체크) 되었습니다.` });
            } catch(e) { 
              console.error("서버 폭파 방어 성공(1):", e); 
            }
          }
        }, 20000); // 20초 (20000ms) 설정
  }
}

function getGameState(room) {
  // 🌟 화면단(UI) 코드를 건드리지 않기 위해, 현재 레벨과 다음 레벨 정보만 담은 가짜 배열을 실시간으로 생성
  let infiniteBlinds = [];
  for (let i = 0; i <= room.blindLevel + 1; i++) {
    infiniteBlinds.push(getBlinds(i));
  }

  return {
    players: room.players, playerOrder: room.playerOrder, pot: room.pot, currentTurnId: room.currentTurnId, highestBet: room.highestBet, 
    minRaise: room.minRaise, communityCards: room.communityCards, stage: room.stage, 
    blindLevel: room.blindLevel, blindEndTime: room.blindEndTime, 
    blinds: infiniteBlinds, // 👈 생성한 가짜 배열을 넣어줌
    uncontestedWinner: room.uncontestedWinner, turnStartTime: room.turnStartTime
  };
}

// 나를 제외한 남의 카드를 완벽하게 지워주는 보안(Anti-Cheat) 전용 함수
function getSafeGameState(room, myId) {
  let safeState = JSON.parse(JSON.stringify(getGameState(room)));
  Object.keys(safeState.players).forEach(otherId => {
    if (otherId !== myId) {
      safeState.players[otherId].cards = []; 
    } else if (safeState.players[myId].cards.length > 0) {
      // 내 카드가 있으면 현재 바닥 카드와 조합하여 족보를 계산해 줍니다
      let evalResult = evaluateHand(safeState.players[myId].cards, safeState.communityCards);
      safeState.players[myId].handName = evalResult.handName;
    }
  });
  return safeState;
}

function broadcastGameState(io, roomCode, room) {
  room.playerOrder.forEach(pId => {
    let p = room.players[pId];
    if (!p.isBot && !p.isOffline) {
      io.to(pId).emit('update_game_state', getSafeGameState(room, pId));
    }
  });
}

io.on('connection', (socket) => {
  
  socket.on('join_room', (data) => {
    const roomCode = String(data.roomCode).substring(0, 20);
    const playerName = String(data.playerName).substring(0, 15);

    // 👇 이 3줄을 추가하세요. 방이 30개 이상 만들어지는 것을 막아 무료 서버 다운을 방지합니다.
    if (Object.keys(rooms).length >= 30 && !rooms[roomCode]) {
      return socket.emit('join_error', '⚠️ 서버가 꽉 찼습니다 (최대 30개 방). 잠시 후 다시 시도해주세요.');
    }
    
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
          socket.emit('game_started', getSafeGameState(room, socket.id)); broadcastGameState(io, roomCode, room);
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
      socket.emit('game_started', getSafeGameState(room, socket.id)); broadcastGameState(io, roomCode, room);
    } else { io.to(roomCode).emit('update_lobby', Object.values(room.players)); }
    
    io.to(roomCode).emit('chat_message', { type: 'sys', msg: `🚪 ${playerName} 님이 입장했습니다.` });
  });

  socket.on('add_bot', () => {
    const room = rooms[socket.roomCode];
    if (room && room.players[socket.id] && room.players[socket.id].isHost && room.status === 'lobby') {
      if (Object.keys(room.players).length >= 10) return socket.emit('system_message', '⚠️ 방이 꽉 찼습니다. (최대 10명)');
      
      let botId = 'bot_' + Math.random().toString(36).substr(2, 9);
      
      // 형용사 50개 (홀덤 상황 + 성격 조합)
      const adjectives = [
        '올인하는', '뻥카치는', '눈치보는', '대담한', '소심한', 
        '운좋은', '돈많은', '파산한', '깐깐한', '졸린', 
        '배고픈', '쫄보인', '블러핑하는', '레이즈하는', '폴드하는', 
        '고민하는', '계산적인', '배짱좋은', '본전찾는', '잃을것없는', 
        '건방진', '친절한', '화난', '멍청한', '똑똑한', 
        '수상한', '억울한', '행복한', '슬픈', '바쁜', 
        '심심한', '귀여운', '무서운', '수줍은', '뻔뻔한', 
        '게으른', '성급한', '느긋한', '예민한', '둔감한', 
        '변덕스러운', '음흉한', '시크한', '엉뚱한', '침착한', 
        '허세부리는', '기대하는', '절망한', '신난', '초조한'
      ];

      // 명사 50개 (친근하고 귀여운 동물들)
      const nouns = [
        '알파카', '너구리', '고양이', '강아지', '거북이', 
        '펭귄', '호랑이', '병아리', '다람쥐', '토끼', 
        '원숭이', '사자', '곰', '여우', '늑대', 
        '돼지', '흑염소', '망아지', '양', '수탉', 
        '오리', '비둘기', '참새', '까마귀', '부엉이', 
        '개구리', '악어', '상어', '고래', '돌고래', 
        '문어', '오징어', '꽃게', '랍스터', '달팽이', 
        '햄스터', '고슴도치', '코끼리', '기린', '하마', 
        '코뿔소', '침팬지', '고릴라', '미어캣', '캥거루', 
        '코알라', '독수리', '펠리컨', '두꺼비', '카멜레온'
      ];

      // 리스트에서 각각 하나씩 랜덤으로 뽑아서 이름 조합 (형용사, 명사 개별 중복 방지 로직)
      let botName = '';
      let isDuplicate = true;
      
      // 뽑은 형용사나 명사가 이미 존재하는지 확인하고, 겹치면 다시 뽑습니다!
      while (isDuplicate) {
        const randomAdj = adjectives[Math.floor(Math.random() * adjectives.length)];
        const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];
        botName = `🤖 ${randomAdj} ${randomNoun}`;
        
        // 현재 방에 있는 사람들의 이름 중에, 방금 뽑은 '형용사'나 '명사'가 단 하나라도 포함되어 있는지 검사합니다.
        isDuplicate = Object.values(room.players).some(p => {
          return p.name.includes(randomAdj) || p.name.includes(randomNoun);
        });
      }
      
      room.players[botId] = {
        id: botId, name: botName, chips: 10000,
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
            if (room.currentTurnId === target.id) {
              handleAction(room, socket.roomCode, target, { action: 'fold' }, io);
            } else {
              target.state = 'folded';
              // 강퇴 후 남은 사람이 1명뿐인지 확인하고, 화면을 즉시 새로고침
              const activePlayers = room.playerOrder.filter(id => room.players[id].state === 'playing' && !room.players[id].isOffline);
              if (activePlayers.length === 1) {
                const winner = room.players[activePlayers[0]];
                winner.chips += room.pot; room.stage = 5; room.uncontestedWinner = winner.id;
                setTimeout(() => { io.to(socket.roomCode).emit('system_message', `🎉 전원 폴드!\n[${winner.name}]님이 패를 숨긴 채 ${room.pot}칩을 가져갑니다.`); }, 500);
              }
              broadcastGameState(io, socket.roomCode, room);
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
      const safeMsg = typeof msg === 'string' ? msg.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;") : "";
      
      io.to(socket.roomCode).emit('chat_message', { type: 'chat', name: pName, msg: safeMsg });
    }
  });

  socket.on('rebuy', () => {
    const room = rooms[socket.roomCode];
    if (room && room.players[socket.id]) {
      const p = room.players[socket.id];
      
      // [오류 수정] 결과창(stage 5)에서는 이미 남에게 넘어간 돈이므로 베팅 금액(invested)을 재산에서 뺍니다.
      const currentInvested = (room.status === 'playing' && room.stage < 5) ? p.invested : 0;
      
      // 진짜 남은 칩 + 아직 승부가 안 난 베팅 칩 + 예약 칩 합산
      const totalWealth = p.chips + currentInvested + (p.pendingRebuy ? 10000 : 0);
      
      if (totalWealth < 10000) {
        if (room.status === 'playing' && room.stage < 5) {
          p.pendingRebuy = 1;
          socket.emit('system_message', "💸 리바이 예약 완료!\n이번 판이 끝나고 다음 판이 시작될 때 충전됩니다.");
        } else {
          p.chips += 10000;
          p.rebuyCount += 1;
          socket.emit('system_message', "💸 리바이 완료!\n10,000 칩이 즉시 충전되었습니다.");
        }
        broadcastGameState(io, socket.roomCode, room);
        io.to(socket.roomCode).emit('chat_message', { type: 'sys', msg: `💸 ${p.name} 님이 리바이를 요청했습니다.` });
      } else {
        // 전재산이 10,000 이상이면 단호하게 거절 메시지를 보냅니다.
        socket.emit('system_message', "⚠️ 충전 불가\n현재 보유 칩(베팅 중인 칩 포함)이 10,000 이상이므로 충전할 수 없습니다.");
      }
    }
  });

  socket.on('start_game', () => {
    const room = rooms[socket.roomCode];
    if (room && room.players[socket.id].isHost && (room.status === 'lobby' || room.stage === 5)) {
      
      if (!room.blindEndTime) { room.blindLevel = 0; room.blindEndTime = Date.now() + BLIND_DURATION; } 
      else if (Date.now() > room.blindEndTime) {
        // 🌟 Math.min(상한선)을 삭제하여 시간이 지나면 무한정 레벨이 오르도록 만듦!
        room.blindLevel += 1; 
        room.blindEndTime = Date.now() + BLIND_DURATION;
      }

      Object.values(room.players).forEach(p => {
        // 💢 1. 리바이(충전)를 하기 전에, 진짜 남은 돈을 기준으로 멘붕 여부를 먼저 판독!
        if (p.isBot) {
          if (p.lastRoundChips && (p.lastRoundChips - p.chips) >= (p.lastRoundChips * 0.3)) {
            p.recentlyLostBig = true;
          }
          if (p.tiltRounds > 0) p.tiltRounds--; 
        }

        // 💸 2. 멘탈 판독이 끝났으니, 안심하고 칩을 충전해 줍니다.
        if (p.pendingRebuy) {
          p.chips += (10000 * p.pendingRebuy);
          p.rebuyCount += p.pendingRebuy;
          p.pendingRebuy = 0;
        }
        if (p.isBot && p.chips < 200) { p.chips += 10000; p.rebuyCount++; }

        // 💾 3. 충전이 모두 끝난 '최종 칩' 금액을 다음 판 비교를 위해 저장해 둡니다.
        if (p.isBot) {
          p.lastRoundChips = p.chips; 
        }
      });

      const currBlinds = getBlinds(room.blindLevel);
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
        let prevDIdx = room.playerOrder.indexOf(room.dealerId);
        let nextDIdx = prevDIdx;
        // 파산한 사람을 건너뛰고, 실제 게임 중인 다음 사람에게 딜러 버튼을 정확히 넘겨줌
        for (let i = 0; i < room.playerOrder.length; i++) {
          nextDIdx = (nextDIdx + 1) % room.playerOrder.length;
          if (activeIds.includes(room.playerOrder[nextDIdx])) {
            dIdx = activeIds.indexOf(room.playerOrder[nextDIdx]);
            break;
          }
        }
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

      // 👇 화면에 데이터를 쏘기 전에, 타이머 시작 시간을 미리 도장 찍어둡니다!
      room.turnStartTime = Date.now();

      // 방 전체에 뿌리지 않고, 각자에게 본인 카드만 보이는 안전한 상태로 개별 전송합니다.
      room.playerOrder.forEach(pId => {
        let p = room.players[pId];
        if (!p.isBot && !p.isOffline) {
          io.to(pId).emit('game_started', getSafeGameState(room, pId));
        }
      });
      
      io.to(socket.roomCode).emit('chat_message', { type: 'sys', msg: `📢 새로운 판이 시작되었습니다!` });
      io.to(socket.roomCode).emit('play_sound', 'deal');
      
      if (room.currentTurnId && room.players[room.currentTurnId].isBot) {
        setTimeout(() => { processBotDecision(room, socket.roomCode, room.players[room.currentTurnId], io); }, 1500);
      } else if (room.currentTurnId) {
        io.to(room.currentTurnId).emit('play_sound', 'my_turn');
        
        // 👇 첫 턴(UTG)에도 20초 타이머를 완벽하게 적용합니다!
        room.turnStartTime = Date.now();
        if (room.turnTimer) clearTimeout(room.turnTimer);
        const expectedTurnId = room.currentTurnId;
        
        room.turnTimer = setTimeout(() => {
          if (rooms[socket.roomCode] === room && room.currentTurnId === expectedTurnId) {
            let p = room.players[expectedTurnId];
            if (!p) { 
              room.currentTurnId = null; 
              findNextTurn(room, room.playerOrder.filter(id => room.players[id].state === 'playing' && !room.players[id].isOffline), false, socket.roomCode, io);
              broadcastGameState(io, socket.roomCode, room);
              return; 
            }

            let callAmount = Math.max(0, (room.highestBet || 0) - (p.currentBet || 0)); // 🛡️ 금액 오류(음수) 방지
            let timeoutAction = callAmount === 0 ? 'call' : 'fold';
            
            try {
              handleAction(room, socket.roomCode, p, { action: timeoutAction }, io);
              io.to(socket.roomCode).emit('chat_message', { type: 'sys', msg: `⏰ [${p.name}] 님이 시간 초과로 자동 진행(폴드/체크) 되었습니다.` });
            } catch(e) { 
              console.error("서버 폭파 방어 성공(2):", e); 
            }
          }
        }, 20000); // 20초 카운트다운
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
      room.uncontestedWinner = null; broadcastGameState(io, socket.roomCode, room);
    }
  });

  socket.on('end_game', () => {
    const room = rooms[socket.roomCode];
    if (room && room.players[socket.id] && room.players[socket.id].isHost) {
      let results = Object.values(room.players).map(p => {
        
        // 👇 게임 진행 중에 종료되었다면, 테이블에 낸 돈(invested)을 임시로 주머니에 돌려받습니다.
        let safeChips = p.chips;
        if (room.status === 'playing' && room.stage < 5) {
          safeChips += p.invested; 
        }

        let totalInvested = 10000 + (p.rebuyCount * 10000);
        let profit = safeChips - totalInvested; // 환불받은 칩을 기준으로 수익을 계산합니다.
        
        return { name: p.name, chips: safeChips, rebuys: p.rebuyCount, profit: profit };
      });
      // ... 아래 생략 ...
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
      
      // [수정됨] 기존에 무조건 폴드시키던 코드를 삭제하고, 아래에서 올인 여부를 검사합니다.

      const onlineHumans = room.playerOrder.filter(id => !room.players[id].isOffline && !room.players[id].isBot);

      if (onlineHumans.length === 0) {
        delete rooms[roomCode]; 
      } else {
        if (wasHost) { player.isHost = false; room.players[onlineHumans[0]].isHost = true; }
        
        if (room.status === 'playing' && player.state === 'playing') {
          // 👇 [올인 보호] 전 재산을 걸었거나, 남은 사람들이 다 올인해서 시스템이 자동 전개 중일 때는 패를 살려둡니다.
          const activeWithChips = room.playerOrder.filter(id => room.players[id].state === 'playing' && room.players[id].chips > 0);
          
          if (player.chips === 0 || activeWithChips.length <= 1) {
             // 올인 상태이거나 자동 진행 중이므로 패를 꺾지 않고 유지 (결과 화면에서 판정받음)
          } else {
             // 일반적인 상황에서 도망갔을 때는 정상적으로 강제 폴드 처리
            if (isMyTurn) {
              handleAction(room, roomCode, player, { action: 'fold' }, io);
            } else {
              player.state = 'folded';
              const activePlayers = room.playerOrder.filter(id => room.players[id].state === 'playing' && !room.players[id].isOffline);
              if (activePlayers.length === 1) {
                const winner = room.players[activePlayers[0]];
                winner.chips += room.pot; room.stage = 5; room.uncontestedWinner = winner.id;
                setTimeout(() => { io.to(roomCode).emit('system_message', `🎉 전원 폴드!\n[${winner.name}]님이 패를 숨긴 채 ${room.pot.toLocaleString()}칩을 가져갑니다.`); }, 500);
              }
              // 보안 패치 유지
              broadcastGameState(io, roomCode, room);
            }
          }
        } else {
          if (room.status === 'lobby') io.to(roomCode).emit('update_lobby', Object.values(room.players));
          // 보안 패치 유지
          else broadcastGameState(io, roomCode, room);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => { console.log(`🚀 채팅, 사운드, 강퇴 기능 추가 완료! (포트: ${PORT})`); });