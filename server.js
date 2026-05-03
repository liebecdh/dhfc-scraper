import express from 'express';
import cron from 'node-cron';
import { initializeApp } from 'firebase/app';
// 🚨 updateDoc 가 추가되었습니다!
import { getFirestore, doc, getDoc, onSnapshot, updateDoc } from 'firebase/firestore';
import admin from 'firebase-admin'; 
import { 
  runScheduleScraper, 
  runRankingsScraper, 
  runLineupScraper 
} from './scraper.js';

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("🚨 환경변수 FIREBASE_SERVICE_ACCOUNT가 없습니다. (푸시 알림 작동 불가)");
} else {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("🔥 파이어베이스 관리자(Admin) 권한 장착 완료!");
}

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
let lastNotifiedMsgId = null;
let lastNotifiedLineupDate = null; // 👈 라인업 푸시 중복 방지용 메모리
let isKLeagueMatchDay = false; // 🚨 [추가] 오늘 K리그 경기가 있는가?

// ==========================================
// 🚨 실시간 라인업 감시 및 푸시 알림 엔진
// ==========================================
function startLineupObserver() {
  if (!admin.apps.length) return;

  const FAMILY_CODE = '조아'; 
  const docRef = doc(db, 'artifacts', 'daejeon-shift-pro-test-sandbox', 'public', 'data', 'userSchedules_v305', FAMILY_CODE);

  console.log("👀 실시간 라인업 감시 레이더 가동 완료...");

  onSnapshot(docRef, (snap) => {
    if (!snap.exists()) return;
    const data = snap.data().content;
    const lineupData = data.lineupData;
    const chat = data.chat;

    if (!lineupData || !lineupData.matchInfo || !chat || !chat.fcmTokens) return;

    const matchDate = lineupData.matchInfo.date;
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

    // 오늘 경기인지, 그리고 이미 오늘 알림을 보냈는지 확인
    if (matchDate !== todayStr || lastNotifiedLineupDate === matchDate) return;

    // 라인업에 선수가 채워졌는지 확인 (forwards에 선수가 들어왔다면 스크래핑 성공으로 간주)
    const isLineupReady = lineupData.DAEJEON && lineupData.DAEJEON.forwards && lineupData.DAEJEON.forwards.length > 0;

    if (isLineupReady) {
      lastNotifiedLineupDate = matchDate; // 오늘 알림 발송 완료 처리

      // 가족 토큰 모으기
      const targetTokens = Object.values(chat.fcmTokens).filter(token => token);
      if (targetTokens.length === 0) return;

      // 오늘 경기 정보 (관제탑 메모리 활용)
      const opponent = lineupData.matchInfo.opponent || todayMatchInfo?.opponent || '상대팀';
      const title = todayMatchInfo?.title || 'K리그1';

      // 라인업 전용 푸시 알림 장전!
      const messagePayload = {
        notification: {
          title: `🚨 [선발 라인업 발표]`,
          body: `${title} 대전 VS ${opponent} 출전 명단이 업데이트되었습니다! ⚽🔥`
        },
        webpush: {
          fcmOptions: {
            link: "/?tab=K-LEAGUE" // 라인업 알림 누르면 K리그 탭으로 자동 이동!
          }
        },
        tokens: targetTokens
      };

      admin.messaging().sendEachForMulticast(messagePayload)
        .then((response) => console.log(`📨 라인업 푸시 발송 성공: ${response.successCount}건`))
        .catch((error) => console.error('❌ 라인업 푸시 발송 에러:', error));
    }
  });
}

// ==========================================
// 🚨 기존 실시간 채팅 감시 엔진
// ==========================================
function startChatObserver() {
  if (!admin.apps.length) return; 

  const FAMILY_CODE = '조아'; 
  const docRef = doc(db, 'artifacts', 'daejeon-shift-pro-test-sandbox', 'public', 'data', 'userSchedules_v305', FAMILY_CODE);

  console.log("👀 실시간 채팅 감시 레이더 가동 완료...");

  onSnapshot(docRef, (snap) => {
    if (!snap.exists()) return;
    const data = snap.data().content;
    const chat = data.chat;
    if (!chat || !chat.messages || chat.messages.length === 0) return;

    const latestMsg = chat.messages[chat.messages.length - 1];
    if (lastNotifiedMsgId === latestMsg.id) return;
    lastNotifiedMsgId = latestMsg.id;

    const tokensMap = chat.fcmTokens || {};
    const targetTokens = Object.entries(tokensMap)
      .filter(([senderKey, token]) => senderKey !== latestMsg.sender && token)
      .map(([senderKey, token]) => token);

    if (targetTokens.length === 0) return; 

    const profiles = {
      dad: { name: '아빠' }, mom: { name: '엄마' }, aseong: { name: '아성이' }, arang: { name: '아랑이' }
    };
    const senderName = profiles[latestMsg.sender]?.name || '가족';
    const notifyBody = latestMsg.imageUrl ? '(사진)' : latestMsg.text;

    const messagePayload = {
      notification: {
        title: `${senderName}님의 메시지 💬`,
        body: notifyBody
      },
      webpush: {
        fcmOptions: {
          link: "/?tab=CHAT" 
        }
      },
      tokens: targetTokens
    };

    admin.messaging().sendEachForMulticast(messagePayload)
      .then((response) => {})
      .catch((error) => console.error('❌ 푸시 알림 발송 에러:', error));
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

// 🚨 [수정 완료] K리그 경기 여부 판단 로직 추가
async function updateTodayMatchMemory() {
  const targetDocRef = doc(db, 'artifacts', 'daejeon-shift-pro-test-sandbox', 'public', 'data', 'userSchedules_v305', '조아');
  const snap = await getDoc(targetDocRef);
  if (snap.exists()) {
    const fixtures = snap.data().content?.kLeagueFixtures || {};
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    
    // 1. 대전 경기 확인
    todayMatchInfo = Object.values(fixtures).find(m => 
      m.dateKey === todayStr && (m.homeTeam.includes('대전') || m.awayTeam.includes('대전'))
    );
    if (todayMatchInfo) {
      console.log(`📅 [메모리] 오늘 대전 경기 감지: ${todayMatchInfo.match} (${todayMatchInfo.time})`);
    } else {
      console.log(`📅 [메모리] 오늘 대전 경기가 없습니다.`);
    }

    // 2. K리그 전체 경기 확인
    isKLeagueMatchDay = Object.values(fixtures).some(m => m.dateKey === todayStr);
    if (isKLeagueMatchDay) {
      console.log(`🏟️ [메모리] 오늘 K리그1 경기가 있습니다. (실시간 스코어 추적 활성화)`);
    } else {
      console.log(`🏟️ [메모리] 오늘 K리그1 경기가 없습니다. (실시간 스코어 추적 휴식)`);
    }
  }
}

// ==========================================
// 🚨 자정(00:00) 라인업 초기화 스케줄러
// ==========================================
cron.schedule('0 0 * * *', async () => {
  await safeExecute('자정 경기 감지 및 라인업 초기화', async () => {
    await updateTodayMatchMemory(); 
    if (todayMatchInfo) {
      const targetDocRef = doc(db, 'artifacts', 'daejeon-shift-pro-test-sandbox', 'public', 'data', 'userSchedules_v305', '조아');
      
      // 오늘 경기가 있다면 이전 라인업을 싹 비워버립니다.
      await updateDoc(targetDocRef, {
        "content.lineupData": {
          matchInfo: {
            date: `${new Date().getFullYear()}-${new Date().getMonth() + 1}-${new Date().getDate()}`,
            opponent: todayMatchInfo.opponent || "상대팀",
            status: "경기전"
          },
          DAEJEON: { formation: '명단 발표 전', forwards: [], midfielders: [], defenders: [], goalkeeper: null },
          OPPONENT: { formation: '명단 발표 전', forwards: [], midfielders: [], defenders: [], goalkeeper: null }
        }
      });
      console.log("🧹 [자정 초기화] 오늘 경기 라인업 데이터를 깨끗하게 비웠습니다.");
    }
  });
}, { timezone: "Asia/Seoul" });


cron.schedule('1 15 * * *', async () => {
  await safeExecute('15시 마스터 일정 전수 업데이트', async () => {
    await runScheduleScraper(true); 
    await updateTodayMatchMemory(); 
  });
}, { timezone: "Asia/Seoul" });

// 🚨 [수정 완료] 경기 없는 날은 추적 안 함!
cron.schedule('*/3 14-22 * * *', async () => {
  if (!isKLeagueMatchDay) return; // 👈 K리그 경기가 없으면 여기서 컷!

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

app.get('/test', async (req, res) => {
  res.send('⚽ [가벼운 청소] 기존 중복 일정을 깨끗하게 비웠습니다! 이제 1~2분 뒤 자동으로 새 일정이 채워집니다.');
  
  await safeExecute('[가벼운 찌꺼기 청소]', async () => {
    const targetDocRef = doc(db, 'artifacts', 'daejeon-shift-pro-test-sandbox', 'public', 'data', 'userSchedules_v305', '조아');
    // 빈 깡통으로 덮어써서 찌꺼기 완벽 삭제
    await updateDoc(targetDocRef, { "content.kLeagueFixtures": {} });
    console.log("🧹 [찌꺼기 청소 완료] 기존 일정을 싹 비웠습니다. 이제 다시 스크래핑을 시작합니다.");
    
    // 청소 후 3초 쉬었다가 다시 채워넣기 시작!
    setTimeout(() => {
        runScheduleScraper(true);
    }, 3000);
  });
});

app.listen(PORT, async () => {
  console.log(`🚀 관제 서버가 포트 ${PORT}에서 시작되었습니다.`);
  await updateTodayMatchMemory(); 
  startChatObserver(); // 채팅 감시
  startLineupObserver(); // 👈 라인업 감시 동시 가동!
});
