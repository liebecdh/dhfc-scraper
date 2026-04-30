import express from 'express';
import cron from 'node-cron';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, onSnapshot } from 'firebase/firestore';
import admin from 'firebase-admin'; // 👈 푸시 알림 쏠 때 쓸 마스터키 도구
import { 
  runScheduleScraper, 
  runRankingsScraper, 
  runLineupScraper 
} from './scraper.js';

// 1. 파이어베이스 서버(마스터키) 초기화
// (Render에 설정해둔 FIREBASE_SERVICE_ACCOUNT 환경변수를 꺼내옵니다)
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("🚨 환경변수 FIREBASE_SERVICE_ACCOUNT가 없습니다. (푸시 알림 작동 불가)");
} else {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("🔥 파이어베이스 관리자(Admin) 권한 장착 완료!");
}

// 2. 파이어베이스 클라이언트 설정 (기존 스크래핑 데이터 저장용)
const firebaseConfig = {
  apiKey: "AIzaSyBKuKbTyQJwEwfsnMQni2X7hiZnS09oiF4",
  authDomain: "dhfc-shift.firebaseapp.com",
  projectId: "dhfc-shift",
  storageBucket: "dhfc-shift.firebasestorage.app",
  appId: "1:182895450339:web:5e5b03916e7233fdbf0dd6"
};
const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);

const app = express();
const PORT = process.env.PORT || 10000;

let isScraping = false; 
let todayMatchInfo = null; 
// 💬 [채팅 감시용 메모리] 가장 마지막에 날린 알림(메시지 ID) 기억하기
let lastNotifiedMsgId = null;

// ==========================================
// 🚨 [핵심] 24시간 실시간 채팅 감시 및 푸시 알림 엔진
// ==========================================
function startChatObserver() {
  if (!admin.apps.length) return; // 관리자 권한 없으면 팅겨냄

  const FAMILY_CODE = '조아'; // 👈 기획자님 가족 공유코드 (추후 환경변수로 빼도 됨)
  const docRef = doc(db, 'artifacts', 'daejeon-shift-pro-test-sandbox', 'public', 'data', 'userSchedules_v305', FAMILY_CODE);

  console.log("👀 실시간 채팅 감시 레이더 가동 완료...");

  onSnapshot(docRef, (snap) => {
    if (!snap.exists()) return;
    const data = snap.data().content;
    const chat = data.chat;
    if (!chat || !chat.messages || chat.messages.length === 0) return;

    // 방금 올라온 가장 따끈따끈한 최신 메시지 하나
    const latestMsg = chat.messages[chat.messages.length - 1];

    // 만약 이미 알림을 보낸 메시지라면 무시 (중복 방지)
    if (lastNotifiedMsgId === latestMsg.id) return;
    lastNotifiedMsgId = latestMsg.id;

    // 가족들의 폰에 심어둔 알림 토큰(수신 주소) 꺼내오기
    const tokensMap = chat.fcmTokens || {};
    // 방금 채팅을 친 당사자의 폰(토큰)은 알림 명단에서 제외
    const targetTokens = Object.entries(tokensMap)
      .filter(([senderKey, token]) => senderKey !== latestMsg.sender && token)
      .map(([senderKey, token]) => token);

    if (targetTokens.length === 0) return; // 보낼 사람이 없으면 패스

    // 보낼 사람의 프로필 정보 찾기 (App.js의 CHAT_PROFILES와 동일 구조)
    const profiles = {
      dad: { name: '아빠' }, mom: { name: '엄마' }, aseong: { name: '아성이' }, arang: { name: '아랑이' }
    };
    const senderName = profiles[latestMsg.sender]?.name || '가족';
    const notifyBody = latestMsg.imageUrl ? '(사진)' : latestMsg.text;

    // 구글 서버로 진짜 알림(Push) 발사!
    const messagePayload = {
      notification: {
        title: `${senderName}님의 메시지 💬`,
        body: notifyBody
      },
      // 👇 알림을 눌렀을 때 이동할 주소 꼬리표 추가!
      webpush: {
        fcmOptions: {
          link: "/?tab=CHAT" 
        }
      },
      tokens: targetTokens
    };

    admin.messaging().sendEachForMulticast(messagePayload)
      .then((response) => {
        console.log(`📨 푸시 알림 발송 성공: ${response.successCount}건 (실패: ${response.failureCount}건)`);
      })
      .catch((error) => {
        console.error('❌ 푸시 알림 발송 에러:', error);
      });
  });
}


async function safeExecute(taskName, taskFn) {
  if (isScraping) {
    console.log(`🚦 [잠깐!] ${taskName} 실행 시도했으나, 이미 다른 작업이 진행 중입니다. 충돌 방지를 위해 스킵합니다.`);
    return;
  }
  isScraping = true;
  console.log(`▶️ [시작] ${taskName} (${new Date().toLocaleTimeString()})`);
  try {
    await taskFn();
  } catch (e) {
    console.error(`❌ [에러] ${taskName} 중 오류 발생:`, e);
  } finally {
    isScraping = false;
    console.log(`✅ [종료] ${taskName}`);
  }
}

async function updateTodayMatchMemory() {
  const targetDocRef = doc(db, 'artifacts', 'daejeon-shift-pro-test-sandbox', 'public', 'data', 'userSchedules_v305', '조아');
  const snap = await getDoc(targetDocRef);
  if (snap.exists()) {
    const fixtures = snap.data().content?.kLeagueFixtures || {};
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    
    todayMatchInfo = Object.values(fixtures).find(m => 
      m.dateKey === todayStr && (m.homeTeam.includes('대전') || m.awayTeam.includes('대전'))
    );
    
    if (todayMatchInfo) {
      console.log(`📅 [메모리] 오늘 대전 경기 감지: ${todayMatchInfo.match} (${todayMatchInfo.time})`);
    } else {
      console.log(`📅 [메모리] 오늘 대전 경기가 없습니다.`);
    }
  }
}

cron.schedule('1 15 * * *', async () => {
  await safeExecute('15시 마스터 일정 전수 업데이트', async () => {
    await runScheduleScraper(true); 
    await updateTodayMatchMemory(); 
  });
}, { timezone: "Asia/Seoul" });

cron.schedule('*/3 14-22 * * *', async () => {
  await safeExecute('라이브 스코어/순위 실시간 추적', async () => {
    await runScheduleScraper(false); 
    await runRankingsScraper();      
  });
}, { timezone: "Asia/Seoul" });

cron.schedule('* * * * *', async () => {
  if (!todayMatchInfo || !todayMatchInfo.time) return;

  const now = new Date();
  const [hh, mm] = todayMatchInfo.time.split(':').map(Number);
  const kickoff = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm);
  const diff = (kickoff - now) / 60000; 

  if (diff <= 90 && diff >= 60) {
    await safeExecute('라인업 1분 단위 핀셋 타격', runLineupScraper);
  }

  if (diff <= -120 && diff >= -140 && now.getMinutes() % 3 === 0) {
    await safeExecute('경기 종료 후 기록 스위핑', runLineupScraper);
  }

  if (now.getHours() === 23 && now.getMinutes() === 0) {
    await safeExecute('오늘 경기 최종 기록 마감', runLineupScraper);
  }
}, { timezone: "Asia/Seoul" });

app.get('/', (req, res) => res.send('⚽ DHFC Scraper Control Tower Active'));

app.listen(PORT, async () => {
  console.log(`🚀 관제 서버가 포트 ${PORT}에서 시작되었습니다.`);
  await updateTodayMatchMemory(); 
  startChatObserver(); // 👈 서버 켜지자마자 채팅 감시 레이더 동시 가동!
});
