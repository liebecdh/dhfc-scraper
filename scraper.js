import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, updateDoc } from 'firebase/firestore';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const firebaseConfig = {
  apiKey: "AIzaSyBKuKbTyQJwEwfsnMQni2X7hiZnS09oiF4",
  authDomain: "dhfc-shift.firebaseapp.com",
  projectId: "dhfc-shift",
  storageBucket: "dhfc-shift.firebasestorage.app",
  appId: "1:182895450339:web:5e5b03916e7233fdbf0dd6"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const FAMILY_KEY = "조아"; 
const APP_ID = 'daejeon-shift-pro-test-sandbox';
const TARGET_YEAR = 2026; 

const VENUE_MAP = {
  '전북': '전주 월드컵', '포항': '포항 스틸야드', '강원': '강릉하이원아레나',
  '안양': '안양 종합', '인천': '인천 전용', '서울': '서울 월드컵',
  '광주': '광주 월드컵', '김천': '김천 종합', '울산': '울산 문수',
  '제주': '제주 월드컵', '부천': '부천 종합', '대전': '대전 월드컵'
};

const PLAYER_CATEGORIES = [
  { name: '득점', key: 'goals' }, { name: '도움', key: 'assists' }, { name: '공격포인트', key: 'points' },
  { name: 'MOM', key: 'mom' }, { name: '평균평점', key: 'rating' }, { name: 'BEST11', key: 'best11' }
];

async function setupTurboPage(browser) {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(0);
    page.setDefaultTimeout(0);

    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
            req.abort(); 
        } else {
            req.continue();
        }
    });
    await page.setCacheEnabled(false);
    await page.setUserAgent('Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36');
    await page.setViewport({ width: 412, height: 915, isMobile: true, hasTouch: true });
    return page;
}

const CHROME_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process'];

// ==========================================
// 1. [일정 스크래퍼] 
// ==========================================
export async function runScheduleScraper(isFullSync = false) {
    console.log(`\n🚀 [일정] ${isFullSync ? '전체 일정 마스터 갱신' : '라이브 일정 추적'} 시작...`);
    const browser = await puppeteer.launch({ headless: true, args: CHROME_ARGS }); 
    const allMatches = {};

    try {
        const startMonth = isFullSync ? 2 : new Date().getMonth() + 1;
        const endMonth = isFullSync ? 12 : new Date().getMonth() + 1;

        for (let m = startMonth; m <= endMonth; m++) {
            const monthStr = m.toString().padStart(2, '0');
            console.log(`🔍 ${monthStr}월 데이터 추출 중...`);
            
            const page = await setupTurboPage(browser); 
            
            try {
                await page.goto(`https://m.sports.naver.com/kfootball/schedule/index?category=kleague&date=${TARGET_YEAR}-${monthStr}-01`, { waitUntil: 'domcontentloaded' });
                await new Promise(r => setTimeout(r, 3500));

                try {
                    await page.waitForSelector('[class*="MatchBox_match_item"]', { timeout: 3000 });
                } catch (e) {
                    console.log(`⚠️ ${monthStr}월은 아직 일정이 없거나 비어있습니다.`);
                }

                await page.evaluate(async () => {
                    await new Promise((resolve) => {
                        let totalHeight = 0; const distance = 400;
                        const timer = setInterval(() => { window.scrollBy(0, distance); totalHeight += distance;
                            if (totalHeight >= document.body.scrollHeight || totalHeight > 10000) { clearInterval(timer); window.scrollTo(0, 0); resolve(); }
                        }, 150);
                    });
                });
                await new Promise(r => setTimeout(r, 1000));

                const monthGames = await page.evaluate((year, vMap) => {
                    const results = {};
                    const matchItems = document.querySelectorAll('[class*="MatchBox_match_item"]');

                    matchItems.forEach(item => {
                        const group = item.closest('[class*="ScheduleLeagueType_match_list_group"]');
                        if (!group) return;
                        const dateMatch = group.querySelector('[class*="ScheduleLeagueType_title"]')?.innerText.trim().match(/(\d+)월\s*(\d+)일/);
                        if (!dateMatch) return;
                        
                        const cleanKey = `${year}-${parseInt(dateMatch[1])}-${parseInt(dateMatch[2])}`; 
                        const roundStr = item.querySelector('[class*="MatchBox_add_info"]')?.innerText.trim() || "K리그1";
                        const timeMatch = item.querySelector('[class*="MatchBox_time"]')?.innerText.match(/\d{2}:\d{2}/);
                        const timeStr = timeMatch ? timeMatch[0] : "미정";

                        let rawStatus = item.querySelector('[class*="MatchBox_status"]')?.innerText.trim() || "경기전";
                        let appStatus = rawStatus.includes("종료") ? "경기종료" : (rawStatus === "예정" ? "경기전" : rawStatus);

                        const teamEls = item.querySelectorAll('[class*="MatchBoxHeadToHeadArea_team__"]');
                        if (teamEls.length < 2) return;
                        const homeTeam = teamEls[0].innerText.trim();
                        const awayTeam = teamEls[1].innerText.trim();

                        const scoreEls = item.querySelectorAll('[class*="MatchBoxHeadToHeadArea_score__"]');
                        let scoreStr = (scoreEls.length >= 2 && appStatus !== "경기전") ? `${scoreEls[0].innerText.trim()} : ${scoreEls[1].innerText.trim()}` : "";

                        const involvesDaejeon = homeTeam.includes('대전') || awayTeam.includes('대전');
                        const isDaejeonHome = homeTeam.includes('대전');
                        const matchType = involvesDaejeon ? (isDaejeonHome ? "H" : "A") : "O";

                        let venueText = "";
                        const matchedHomeTeamKey = Object.keys(vMap).find(t => homeTeam.includes(t));
                        if (matchedHomeTeamKey) { venueText = vMap[matchedHomeTeamKey]; if (involvesDaejeon) venueText += isDaejeonHome ? "(홈)" : "(원정)"; } 
                        else { venueText = `${homeTeam} 홈구장`; }

                        const uniqueKey = `${cleanKey}_${homeTeam}_${awayTeam}`;

                        results[uniqueKey] = { title: roundStr, opponent: involvesDaejeon ? (isDaejeonHome ? awayTeam : homeTeam) : awayTeam, match: `${homeTeam} vs ${awayTeam}`, homeTeam, awayTeam, time: timeStr, venue: venueText, type: matchType, score: scoreStr, status: appStatus, dateKey: cleanKey, naverGameId: item.querySelector('a[href*="/game/"]')?.getAttribute('href')?.match(/\d+/)?.[0] || "" };
                    });
                    return results;
                }, TARGET_YEAR, VENUE_MAP);

                Object.assign(allMatches, monthGames);
            } finally {
                await page.close(); 
            }
        }
        
        const targetDocRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'userSchedules_v305', FAMILY_KEY);
        
        if (isFullSync) {
            await updateDoc(targetDocRef, { "content.kLeagueFixtures": allMatches });
        } else {
            const docSnap = await getDoc(targetDocRef);
            const currentFixtures = docSnap.exists() ? (docSnap.data().content?.kLeagueFixtures || {}) : {};
            await updateDoc(targetDocRef, { "content.kLeagueFixtures": { ...currentFixtures, ...allMatches } });
        }
        console.log(`🎉 [일정] 업데이트 완료!`);
    } catch (error) { console.error("❌ 오류:", error); } 
    finally { await browser.close(); }
}

// ==========================================
// 2. [순위 스크래퍼] - 에러 방어막(try-catch) 추가
// ==========================================
export async function runRankingsScraper() {
  console.log(`\n🚀 [순위] ${TARGET_YEAR}년 랭킹 데이터 수집 시작...`);
  const browser = await puppeteer.launch({ headless: true, args: CHROME_ARGS });
  
  try {
    const page = await setupTurboPage(browser); 
    let teamStandings = [];
    const finalPlayerRankings = {};

    await page.goto(`https://m.sports.naver.com/kfootball/record/kleague?seasonCode=${TARGET_YEAR}`, { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 3500));

    console.log(`🛡️ [팀 순위] 데이터 추출 중...`);
    await page.evaluate(() => { const teamBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('팀 순위')); if(teamBtn) teamBtn.click(); });
    await new Promise(r => setTimeout(r, 1500));

    teamStandings = await page.evaluate(() => {
        const results = [];
        document.querySelectorAll('.TableBody_type_team_record [class*="TableBody_item__"], [class*="TableBody_item__"]').forEach((row, idx) => {
            const teamName = row.querySelector('strong, [class*="TeamInfo_name__"], [class*="name__"]')?.textContent.trim();
            if(!teamName) return;
            const cleanNum = (text) => parseInt(text.replace(/[^0-9-]/g, ''), 10) || 0;
            const stats = Array.from(row.querySelectorAll('[class*="TextInfo_text__"]')).map(el => el.textContent.trim());
            if (stats.length >= 8) { results.push({ rank: idx + 1, teamName: teamName, gainPoint: cleanNum(stats[0]), gameCount: cleanNum(stats[1]), won: cleanNum(stats[2]), drawn: cleanNum(stats[3]), lost: cleanNum(stats[4]), gainGoal: cleanNum(stats[5]), loseGoal: cleanNum(stats[6]), goalGap: cleanNum(stats[7]) }); }
        });
        return results.slice(0, 12);
    });

    console.log(`🏃‍♂️ [선수 기록] 탭으로 이동 중...`);
    await page.evaluate(() => { const playerBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('선수 기록')); if(playerBtn) playerBtn.click(); });
    await new Promise(r => setTimeout(r, 1500));
    await page.evaluate(async () => { await new Promise((r) => { let h = 0; const t = setInterval(() => { window.scrollBy(0, 400); h += 400; if (h > 8000) { clearInterval(t); window.scrollTo(0, 0); r(); } }, 100); }); });
    await new Promise(r => setTimeout(r, 1500));

    for (const cat of PLAYER_CATEGORIES) {
        console.log(`🖱️ [${cat.name}] 추출 중...`);
        try {
            await page.evaluate((catName) => { const targetBtn = Array.from(document.querySelectorAll('[class*="TableHead_button_sort__"]')).find(btn => btn.textContent.includes(catName)); if (targetBtn) targetBtn.click(); }, cat.name);
            await new Promise(r => setTimeout(r, 1500));

            finalPlayerRankings[cat.key] = await page.evaluate(() => {
                const results = [];
                const rows = document.querySelectorAll('[class*="TableBody_item__"]');
                for (let i = 0; i < Math.min(30, rows.length); i++) {
                    const row = rows[i];
                    const valueEl = row.querySelector('[class*="TextInfo_highlight__"]');
                    let valueStr = '0';
                    if (valueEl) { const clone = valueEl.cloneNode(true); const blindEl = clone.querySelector('.blind'); if (blindEl) blindEl.remove(); valueStr = clone.textContent.trim(); }
                    results.push({ rank: parseInt(row.querySelector('[class*="PlayerInfo_ranking__"]')?.textContent.replace(/[^0-9]/g, '') || String(i + 1), 10), name: row.querySelector('[class*="PlayerInfo_name__"]')?.textContent.trim() || '이름없음', team: row.querySelector('[class*="PlayerInfo_team__"]')?.textContent.trim() || '', value: valueStr.replace(/[^0-9.]/g, '') });
                }
                return results;
            });
        } catch (catErr) {
            console.log(`⚠️ ${cat.name} 추출 중 메모리 부족 등으로 컨텍스트 유실(무시하고 진행): ${catErr.message}`);
        }
    }

    const targetDocRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'userSchedules_v305', FAMILY_KEY);
    await updateDoc(targetDocRef, { "content.kLeagueStandings": teamStandings, "content.kLeaguePlayers": finalPlayerRankings });
    console.log(`🎉 [순위] 팀/선수 업데이트 완료!`);
  } catch (error) { console.error("❌ 오류 발생:", error); } 
  finally { await browser.close(); }
}

// ==========================================
// 3. [라인업 스크래퍼] - 🚨 스마트 필터 장착 완료 (예정, 시간 텍스트 완벽 차단)
// ==========================================
export async function runLineupScraper() {
  console.log(`\n🔍 [라인업] 대전 경기 탐색 중...`);
  const browser = await puppeteer.launch({ headless: true, args: CHROME_ARGS });

  try {
    const targetDocRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'userSchedules_v305', FAMILY_KEY);
    const docSnap = await getDoc(targetDocRef);
    if (!docSnap.exists() || !docSnap.data().content || !docSnap.data().content.kLeagueFixtures) { console.log(`❌ DB에 일정 데이터가 없습니다.`); return; }

    const content = docSnap.data().content;
    const fixtures = content.kLeagueFixtures;
    const now = new Date();
    
    const parseSafeDate = (dateKey, timeStr = '00:00') => {
        const [y, m, d] = dateKey.split('-').map(Number);
        const [hh, mm] = (timeStr === '미정' ? '00:00' : timeStr).split(':').map(Number);
        return new Date(y, m - 1, d, hh, mm);
    };

    let targetMatch = null;
    const sortedFixtures = Object.values(fixtures).sort((a, b) => parseSafeDate(a.dateKey, a.time) - parseSafeDate(b.dateKey, b.time));

    for (const match of sortedFixtures) {
        const matchDate = parseSafeDate(match.dateKey, "23:59"); 
        if ((match.homeTeam.includes('대전') || match.awayTeam.includes('대전')) && matchDate >= now) { targetMatch = match; break; }
    }

    if (!targetMatch || !targetMatch.naverGameId) { console.log(`⚠️ 수집 가능한 대전 경기를 찾을 수 없습니다.`); return; }
    console.log(`🎯 타겟팅 성공: [${targetMatch.dateKey}] ${targetMatch.match}`);
    
    const page = await setupTurboPage(browser); 
    await page.goto(`https://m.sports.naver.com/game/${targetMatch.naverGameId}/lineup`, { waitUntil: 'domcontentloaded' });
    
    await new Promise(r => setTimeout(r, 4500));
    
    await page.evaluate(async () => { await new Promise((r) => { let h = 0; const t = setInterval(() => { window.scrollBy(0, 400); h += 400; if (h > 6000) { clearInterval(t); r(); } }, 100); }); });
    await new Promise(r => setTimeout(r, 1000));

    const extractedData = await page.evaluate(() => {
        const playersMap = new Map(); 
        const posList = ['GK','DF','MF','FW','ST','CB','LB','RB','LWB','RWB','CDM','CM','CAM','LM','RM','CF','SUB'];
        const teamNames = ['서울', '대전', '울산', '포항', '김천', '제주', '전북', '광주', '강원', '인천', '대구', '수원', '안양', '부천'];
        const exactBlocked = ['감독', '코치', '승', '무', '패', '기록', '상세', '보기', '교체', '투입', '아웃', '홈', '원정', '선발', '후보', '명단', '예정', '종료'];

        document.querySelectorAll('div, li, span, a').forEach((el) => {
            const text = el.innerText?.trim() || '';
            if (text.length === 0 || text.length > 40) return;

            let lines = text.split('\n').map(l => l.trim().replace(/\s*\d+['’′]$/, '')).filter(l => l);

            if (lines.length === 1) {
                const match = lines[0].match(/^(\d{1,2})\s+(.+)/);
                if (match) {
                    let rest = match[2];
                    let foundPos = '';
                    for (let p of posList) {
                        if (rest.toUpperCase().endsWith(' ' + p)) {
                            foundPos = p;
                            rest = rest.slice(0, -(p.length + 1)).trim();
                            break;
                        }
                    }
                    lines = [match[1], rest];
                    if (foundPos) lines.push(foundPos);
                }
            }

            if (lines.length < 2 || lines.length > 8) return;

            const noStr = lines.find(l => /^\d{1,2}$/.test(l));
            if (!noStr) return;
            const no = parseInt(noStr, 10);
            if (no === 0) return;

            // 🚨 핵심 필터: 공백을 제거한 글자가 2~7글자 사이의 '순수 한글' 또는 '영문자'로만 이루어져야 통과 (숫자, 콜론(:), 마침표(.) 등 특수문자 완벽 차단)
            const name = lines.find(l => {
                const clean = l.replace(/\s/g, '');
                return clean.length >= 2 && clean.length <= 7 && /^[가-힣a-zA-Z]+$/.test(clean) && !posList.includes(l.toUpperCase()) && !teamNames.includes(l) && !exactBlocked.includes(l);
            });
            if (!name) return;

            const pos = lines.find(l => posList.includes(l.toUpperCase())) || '';

            let photo = null;
            const img = el.querySelector('img[src*="pstatic.net"]');
            if (img) {
                const src = img.getAttribute('src');
                if (!src.match(/(1x1|badge|logo|emblem|svg|icon)/i)) {
                    photo = src.startsWith('//') ? 'https:' + src : src;
                }
            }

            let subTime = null;
            let subOutFlag = false;
            let replacedName = null;
            if (text.includes('교체')) {
                const timeMatch = text.match(/(\d+)\s*['’′]/);
                if (timeMatch) subTime = timeMatch[1];
                else subOutFlag = true;
            }

            const uniqueKey = `${no}_${name.replace(/\s+/g, '')}`;
            const existing = playersMap.get(uniqueKey) || { 
                no, name, pos, photo, rating: '-', goals: 0, ownGoals: 0, 
                subTime, subOutFlag, replacedName, 
                yellowCard: text.includes('경고'), 
                redCard: text.includes('퇴장'), 
                rectLeft: el.getBoundingClientRect().left 
            };

            if (!existing.photo && photo) existing.photo = photo;
            if (!existing.pos && pos) existing.pos = pos;
            existing.rectLeft = el.getBoundingClientRect().left;

            playersMap.set(uniqueKey, existing);
        });

        const formMatches = document.body.innerText.match(/(\d\s*-\s*\d\s*-\s*\d|\d\s*-\s*\d\s*-\s*\d\s*-\s*\d)/g);
        return { 
            players: Array.from(playersMap.values()), 
            homeForm: formMatches ? formMatches[0].replace(/\s/g, '') : '4-3-3', 
            awayForm: formMatches ? formMatches[formMatches.length - 1].replace(/\s/g, '') : '4-3-3' 
        };
    });

    if (extractedData.players.length === 0) { console.log(`⚠️ 경기 전입니다. 라인업이 아직 발표되지 않았습니다.`); return; }

    await page.goto(`https://m.sports.naver.com/game/${targetMatch.naverGameId}/record`, { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 3500)); 
    await page.evaluate(async () => { window.scrollBy(0, 1500); await new Promise(r => setTimeout(r, 500)); window.scrollBy(0, -1500); });

    const recordData = await page.evaluate(() => {
        const ratings = {}; const goals = {}; const ownGoals = {}; 
        document.querySelectorAll('tbody tr').forEach(tr => {
            const nameEl = tr.querySelector('th span.blind');
            if (nameEl) {
                let nameParts = nameEl.innerText.trim().split(' ');
                if (['FW', 'MF', 'DF', 'GK'].includes(nameParts[nameParts.length - 1])) nameParts.pop();
                const cleanName = nameParts.join(' ').replace(/[0-9'’′]/g, '').trim();
                const tds = tr.querySelectorAll('td');
                if (tds.length >= 2) { const rating = tds[tds.length - 2].innerText.trim(); if (rating && rating !== '-') ratings[cleanName] = rating; }
            }
        });
        document.querySelectorAll('[class*="ScoreBox_score_list"]').forEach(list => {
            list.querySelectorAll('li').forEach(item => {
                const nameEl = item.querySelector('[class*="name"]');
                if (nameEl) {
                    const isOG = item.innerText.includes('자책골') || item.innerText.includes('OG');
                    const cleanName = nameEl.innerText.replace(/[0-9'’′]/g, '').replace(/\(자책골\)/g, '').replace(/자책골/g, '').replace(/\(OG\)/gi, '').replace(/OG/gi, '').trim();
                    let goalCount = item.querySelectorAll('[class*="ScoreBox_time"]').length || item.querySelectorAll('svg').length || 1;
                    if (isOG) ownGoals[cleanName] = (ownGoals[cleanName] || 0) + goalCount;
                    else goals[cleanName] = (goals[cleanName] || 0) + goalCount;
                }
            });
        });
        return { ratings, goals, ownGoals };
    });

    const allPlayers = extractedData.players;
    const hStarters = allPlayers.slice(0, 11); const aStarters = allPlayers.slice(11, 22);
    const hBench = allPlayers.slice(22).filter(p => p.rectLeft < 206); const aBench = allPlayers.slice(22).filter(p => p.rectLeft >= 206);

    const merge = (p) => {
        if (!p || !p.name) return p || { name: '' };
        const clean = p.name.replace(/\s+/g, '');
        p.rating = recordData.ratings[Object.keys(recordData.ratings).find(k => k.replace(/\s+/g, '') === clean)] || '-';
        p.goals = recordData.goals[Object.keys(recordData.goals).find(k => k.replace(/\s+/g, '') === clean)] || 0;
        p.ownGoals = recordData.ownGoals[Object.keys(recordData.ownGoals).find(k => k.replace(/\s+/g, '') === clean)] || 0;
        return p;
    };

    const isDaejeonHome = targetMatch.homeTeam.includes('대전');
    const homeFinal = { formation: extractedData.homeForm, forwards: hStarters.slice(1).reverse().map(p => ({...merge(p), subOut: p.subOutFlag || null})), goalkeeper: merge(hStarters[0] || {name:''}), bench: hBench.map(p => ({...merge(p), subIn: p.subTime || null})) };
    const awayFinal = { formation: extractedData.awayForm, forwards: (aStarters.length === 11 ? aStarters.slice(0, 10) : aStarters.filter(p => !(p.pos||'').toUpperCase().includes('G'))).map(p => ({...merge(p), subOut: p.subOutFlag || null})), goalkeeper: merge(aStarters.find(p => (p.pos||'').toUpperCase().includes('G')) || aStarters[aStarters.length-1] || {name:''}), bench: aBench.map(p => ({...merge(p), subIn: p.subTime || null})) };

    const finalLineup = {
        matchInfo: { opponent: isDaejeonHome ? targetMatch.awayTeam : targetMatch.homeTeam, date: targetMatch.dateKey },
        DAEJEON: isDaejeonHome ? homeFinal : awayFinal, DAEJEON_BENCH: isDaejeonHome ? homeFinal.bench : awayFinal.bench,
        OPPONENT: isDaejeonHome ? awayFinal : homeFinal, OPPONENT_BENCH: isDaejeonHome ? awayFinal.bench : homeFinal.bench
    };
    
    if (finalLineup.DAEJEON.goalkeeper?.name) {
        await updateDoc(targetDocRef, { "content.lineupData": finalLineup });
        console.log(`🎉 [라인업] ${targetMatch.match} DB 저장 완료!`);
    }

  } catch (error) { console.error("❌ 내부 오류:", error); } 
  finally { await browser.close(); }
}
