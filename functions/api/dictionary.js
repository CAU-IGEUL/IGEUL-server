// functions/api/dictionary.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const crypto = require('crypto');
const { OpenAI } = require('openai');
const cors = require('cors')({ origin: true });

const { getAuthenticatedUser } = require('../utils/auth');

const db = admin.firestore();

/**
 * 백그라운드에서 단어사전 생성을 처리하는 내부 함수
 * @param {string} jobId - Firestore 문서 ID
 * @param {string} text - 분석할 원문 텍스트
 */
const processDictionaryJob = async (jobId, text) => {
    const jobRef = db.collection('dictionaryJobs').doc(jobId);
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const googleCseApiKey = process.env.GOOGLE_CSE_API_KEY;
    const googleCseCx = process.env.GOOGLE_CSE_CX;

    try {
        // --- [수정 1] 사용자 프로필 정보 조회 ---
        const jobDoc = await jobRef.get();
        const jobData = jobDoc.data();
        const userId = jobData.userId;
        const userProfileSnap = await db.collection('users').doc(userId).get();
        const userProfile = userProfileSnap.exists ? userProfileSnap.data() : { knownTopics: [] };

        let knownTopics = userProfile.knownTopics || [];
        // 사용자의 관심 주제(knownTopics)가 비어있는 경우, 모든 주제 목록을 기본값으로 사용
        if (!knownTopics || knownTopics.length === 0) {
            console.warn(`[Job ID: ${jobId}] User ID ${userId} has no knownTopics. Falling back to all topics for better extraction and tagging.`);
            knownTopics = ['정치', '경제', '사회', '생활/문화', 'IT', '과학'];
        }
        const availableTags = [...new Set([...knownTopics, '일반'])]; // 중복 제거 포함

        // 1. OpenAI API를 호출하여 어려운 단어와 주제 단어를 태그와 함께 추출
        const wordExtractionPrompt = `
            너는 한국어 어휘 분석 전문가야. 주어진 텍스트에서 아래 기준에 부합하는 단어를 합쳐 최대 15개까지만 추출해줘.

            ## 추출 기준
            1.  **고급 어휘:** 일상 대화에서는 자주 쓰이지 않는 학술적, 기술적, 또는 한자 기반의 단일 명사. (예: '온톨로지', '변증법')
            2.  **전문 용어:** 사용자의 관심 주제와 관련된 특정 분야의 용어. 약어(Acronym)를 포함해. (예: 'GPU', 'AI', 'M&A')

            ## 제외 기준 (매우 중요)
            - **'스멀스멀', '반갑다'와 같은 의성어, 의태어, 일반적인 형용사, 동사는 절대로 추출하지 마.**
            - **'경영은 전쟁과 같다'와 같은 비유적 표현이나 문장은 추출하지 마.**
            - '심각한 논쟁', '분석적 사고'처럼, 각 단어의 의미를 조합하여 뜻을 쉽게 유추할 수 있는 일반적인 명사구는 절대로 추출하지 마.

            ## 사용자의 관심 주제: [${knownTopics.join(', ')}]
            ## 사용 가능한 태그: [${availableTags.join(', ')}]

            결과는 반드시 다음 형식의 JSON 객체로 반환해줘:
            {"words": [{"word": "추출단어1", "tag": "태그1"}, ...]}

            ## 분석할 텍스트
            - 텍스트: "${text}"
            - 결과:
        `;

        const wordExtractionCompletion = await openai.chat.completions.create({
            model: "gpt-4-turbo",
            messages: [
                {"role": "system", "content": "You are an expert in Korean vocabulary analysis and return only a single JSON object with a 'words' key. The value is an array of objects, each with 'word' and 'tag' keys."},
                {"role": "user", "content": wordExtractionPrompt}
            ],
            response_format: { type: "json_object" },
        });

        let extractedWordObjects = [];
        try {
            const responseContent = wordExtractionCompletion.choices[0].message.content;
            const parsedResponse = JSON.parse(responseContent);
            // .words가 있고 배열인 경우에만 할당, 아닐 경우 빈 배열
            if (parsedResponse && Array.isArray(parsedResponse.words)) {
                extractedWordObjects = parsedResponse.words;
            }
        } catch (parseError) {
            console.warn("Failed to parse word extraction response:", parseError);
        }
        
        if (extractedWordObjects.length === 0) {
            await jobRef.update({
                status: 'completed',
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                result: [],
            });
            return;
        }

        // --- [수정 2] 단어별 문맥 추출을 위한 문장 분리 ---
        const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

        // 2. 각 단어에 대한 정보 (정의, 이미지 등) 생성 (병렬 처리)
        const dictionaryDataPromises = extractedWordObjects.map(async (wordObject) => {
            // wordObject가 객체이고 word 키가 있는지 확인
            if (typeof wordObject !== 'object' || !wordObject.word) {
                console.warn("Invalid word object found:", wordObject);
                return null; // 유효하지 않은 객체는 건너뜀
            }
            const { word, tag } = wordObject;

            // --- [수정 3] 단어의 문맥(문장) 찾기 ---
            const contextSentence = sentences.find(s => s.includes(word)) || '';
            
            // 2a. OpenAI API로 문맥을 고려한 한 줄 정의 및 상세 설명 생성
            const definitionPrompt = `
                "${contextSentence}" 라는 문맥 안에서 사용된 한국어 단어 "${word}"에 대해 다음 정보를 JSON 형식으로 제공해줘.

                ## 추가 지침 (매우 중요)
                - **만약 단어가 'GPU', 'AI', 'M&A'와 같은 약어(Acronym)일 경우, 'longDefinition'에 반드시 전체 이름(Full Name)을 포함해서 설명해줘.**

                ## 참고: 사용자의 전문 분야
                - 사용자는 [${knownTopics.join(', ')}] 분야에 익숙해. 만약 이와 관련된 전문 용어라면, 해당 분야의 의미를 우선적으로 설명해야 해.

                ## 출력 형식
                {
                    "shortDefinition": "한 줄로 요약된 정의 (20자 이내)",
                    "longDefinition": "문맥과 전문 분야를 고려한 상세한 설명 (100자 이내)"
                }

                ## 예시 (약어)
                문맥: "최신 AI 기술은 빠른 GPU를 필요로 합니다."
                단어: "GPU"
                결과: {
                    "shortDefinition": "그래픽 처리 장치",
                    "longDefinition": "Graphics Processing Unit의 약자로, 컴퓨터 그래픽을 렌더링하고 이미지 처리를 가속화하는 전문 전자 회로입니다."
                }

                ## 예시 (IT 문맥)
                문맥: "부모 클래스의 속성을 상속받습니다."
                단어: "부모"
                결과: {
                    "shortDefinition": "상위 클래스 또는 기반 클래스",
                    "longDefinition": "객체 지향 프로그래밍에서 다른 클래스에게 속성이나 메서드를 물려주는 상위 클래스를 의미합니다."
                }
                
                ## 예시 (일반 문맥)
                문맥: "사과와 배는 맛있는 과일입니다."
                단어: "배"
                결과: {
                    "shortDefinition": "먹는 과일의 한 종류",
                    "longDefinition": "달고 과즙이 풍부하며, 둥글거나 서양배처럼 길쭉한 모양을 가진 과일입니다."
                }

                단어: "${word}"
                문맥: "${contextSentence}"
                결과:
            `;

            const definitionCompletion = await openai.chat.completions.create({
                model: "gpt-4-turbo",
                messages: [
                    {"role": "system", "content": "You are an expert in Korean definitions who understands context and returns only a JSON object."},
                    {"role": "user", "content": definitionPrompt}
                ],
                response_format: { type: "json_object" },
            });

            let shortDefinition = '';
            let longDefinition = '';
            try {
                const defResponse = JSON.parse(definitionCompletion.choices[0].message.content);
                shortDefinition = defResponse.shortDefinition || '';
                longDefinition = defResponse.longDefinition || '';
            } catch (parseError) {
                console.warn(`Failed to parse definition for "${word}":`, parseError);
                shortDefinition = `${word}에 대한 정의를 찾을 수 없습니다.`;
                longDefinition = `${word}에 대한 상세 정의를 찾을 수 없습니다.`;
            }

            // 2b. Google Custom Search API로 이미지 URL 검색
            let imageUrl = '';
            if (googleCseApiKey && googleCseCx) {
                const googleSearchUrl = `https://www.googleapis.com/customsearch/v1?key=${googleCseApiKey}&cx=${googleCseCx}&q=${encodeURIComponent(word)}&searchType=image&num=1`;
                try {
                    const searchResponse = await fetch(googleSearchUrl);
                    const searchData = await searchResponse.json();
                    if (searchData.items && searchData.items.length > 0) {
                        imageUrl = searchData.items[0].link;
                    }
                } catch (searchError) {
                    console.warn(`Failed to fetch image for "${word}":`, searchError);
                }
            }

            return {
                term: word,
                tag: tag || '일반', // 태그가 없는 경우 '일반'으로 폴백
                shortDefinition,
                longDefinition,
                imageUrl,
            };
        });

        // null 값을 필터링하여 최종 데이터 생성
        const dictionaryData = (await Promise.all(dictionaryDataPromises)).filter(Boolean);

        // 3. Firestore에 결과 업데이트
        await jobRef.update({
            status: 'completed',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            result: dictionaryData,
        });

    } catch (error) {
        console.error(`[Job ID: ${jobId}] 단어사전 생성 실패:`, error);
        await jobRef.update({
            status: 'failed',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            error: error.message,
        });
    }
};

// ==================================================================
// 6. [API] 단어사전 생성(POST) 및 조회(GET) API
// ==================================================================
const dictionaryApi = functions.runWith({ secrets: ["OPENAI_API_KEY", "GOOGLE_CSE_API_KEY", "GOOGLE_CSE_CX"] })
    .https.onRequest((request, response) => {
    cors(request, response, async () => {
        try {
            const user = await getAuthenticatedUser(request);
            const userId = user.uid;

            if (request.method === 'POST') {
                // --- 작업 생성 ---
                const { paragraphs } = request.body;

                if (!paragraphs || !Array.isArray(paragraphs) || paragraphs.some(p => typeof p.text !== 'string')) {
                    return response.status(400).json({ status: 'error', message: '유효한 paragraphs 배열이 필요합니다.' });
                }

                const fullText = paragraphs.map(p => p.text).join('\n\n');

                if (!fullText.trim()) {
                    return response.status(400).json({ status: 'error', message: '분석할 텍스트가 비어 있습니다.' });
                }

                const jobId = crypto.randomBytes(16).toString('hex');
                const jobRef = db.collection('dictionaryJobs').doc(jobId);

                await jobRef.set({
                    userId: userId,
                    status: 'processing',
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                });

                // 백그라운드에서 실제 작업 시작
                // Note: processDictionaryJob is called without await to run in background
                processDictionaryJob(jobId, fullText);

                response.status(202).json({
                    status: 'processing',
                    jobId: jobId,
                });

            } else if (request.method === 'GET') {
                // --- 결과 조회 ---
                const { jobId } = request.query;
                if (!jobId) {
                    return response.status(400).json({ status: 'error', message: 'jobId가 필요합니다.' });
                }

                const jobRef = db.collection('dictionaryJobs').doc(jobId);
                const jobSnap = await jobRef.get();

                if (!jobSnap.exists) {
                    return response.status(404).json({ status: 'error', message: '해당 작업을 찾을 수 없습니다.' });
                }

                const jobData = jobSnap.data();
                
                // 다른 사용자의 결과에 접근하는 것을 방지 (선택 사항이지만 권장)
                if (jobData.userId !== userId) {
                    return response.status(403).json({ status: 'error', message: '접근 권한이 없습니다.' });
                }

                response.status(200).json({
                    status: jobData.status,
                    data: jobData.result || null,
                    error: jobData.error || null,
                });

            } else {
                response.status(405).send('Only GET or POST requests are allowed.');
            }

        } catch (error) {
            if (error.message.includes('토큰')) {
                response.status(401).json({ status: "error", message: error.message });
            } else {
                console.error("Dictionary API 에러:", error);
                response.status(500).json({ status: "error", message: "서버 내부 오류", details: error.message });
            }
        }
    });
});

module.exports = {
    dictionaryApi
};
