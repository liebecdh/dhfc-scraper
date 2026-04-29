import express from 'express';
import cron from 'node-cron';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc } from 'firebase/firestore';
import { 
  runScheduleScraper, 
  runRankingsScraper, 
  runLineupScraper 
} from './scraper.js';

// 1. 서버 및 파이어베이스 설정 (기존 설정 활용)
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
const PORT = process.env.PORT || 3000;

// 🚦 [신호등] 현재 스크래핑 진행 여부
let isScraping = false; 
// ⚽ [메모리] 오늘 대전 경기 정보 (킥오프 시간 등)
let todayMatchInfo = null; 

// 헬퍼: 안전한 실행 함수 (신호등 제어)
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

// 헬퍼: 오늘 대전 경기 시간 확인 로직
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

// ==========================================
// ⏰ 1. 매일 15:01분: 일정 전수 조사 (기획자님 룰)
// ==========================================
cron.schedule('1 15 * * *', async () => {
  await safeExecute('15시 마스터 일정 전수 업데이트', async () => {
    await runScheduleScraper(true); // 2~12월 전수 조사
    await updateTodayMatchMemory(); // 오늘 경기 시간 메모리에 저장
  });
}, { timezone: "Asia/Seoul" });

// ==========================================
// ⏰ 2. 경기 날 14:00 ~ 22:00: 일정/순위 3분 주기 추적
// ==========================================
cron.schedule('*/3 14-22 * * *', async () => {
  await safeExecute('라이브 스코어/순위 실시간 추적', async () => {
    await runScheduleScraper(false); // 이번 달만 갱신
    await runRankingsScraper();      // 팀/개인 순위 갱신
  });
}, { timezone: "Asia/Seoul" });

// ==========================================
// ⏰ 3. 라인업 & 평점 정밀 타격 (1분 주기로 조건 체크)
// ==========================================
cron.schedule('* * * * *', async () => {
  if (!todayMatchInfo || !todayMatchInfo.time) return;

  const now = new Date();
  const [hh, mm] = todayMatchInfo.time.split(':').map(Number);
  const kickoff = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm);
  const diff = (kickoff - now) / 60000; // 분 단위 차이

  // (A) 킥오프 90분전 ~ 60분전: 라인업 1분 단위 수집
  if (diff <= 90 && diff >= 60) {
    await safeExecute('라인업 1분 단위 핀셋 타격', runLineupScraper);
  }

  // (B) 킥오프 120분후 ~ 140분후: 평점/기록 3분 단위 수집
  // (3분 주기를 맞추기 위해 현재 분이 3으로 나누어 떨어질 때만 실행)
  if (diff <= -120 && diff >= -140 && now.getMinutes() % 3 === 0) {
    await safeExecute('경기 종료 후 기록 스위핑', runLineupScraper);
  }

  // (C) 밤 23:00 최종 마감 (마지막 1번 더)
  if (now.getHours() === 23 && now.getMinutes() === 0) {
    await safeExecute('오늘 경기 최종 기록 마감', runLineupScraper);
  }
}, { timezone: "Asia/Seoul" });

// 수면 모드 방지용 및 초기 가동
app.get('/', (req, res) => res.send('⚽ DHFC Scraper Control Tower Active'));
app.listen(PORT, async () => {
  console.log(`🚀 관제 서버가 포트 ${PORT}에서 시작되었습니다.`);
  await updateTodayMatchMemory(); // 서버 켜지자마자 오늘 경기 있는지 확인
});
