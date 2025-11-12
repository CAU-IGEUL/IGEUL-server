// Firebase Functions 및 Node.js의 기본 모듈 호출
const functions = require('firebase-functions');
const crypto = require('crypto');
const { OpenAI } = require('openai');

// Firebase Admin SDK 추가 (토큰 검증 및 DB 접근용)
const admin = require('firebase-admin');
admin.initializeApp();

const db = admin.firestore(); // Firestore 인스턴스 초기화

/**
 * (헬퍼 함수) 요청 헤더에서 ID 토큰을 추출하고 검증하여 사용자 정보를 반환
 */
const getAuthenticatedUser = async (request) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new Error('인증 토큰이 없습니다. (No token)');
    }
    const idToken = authHeader.split('Bearer ')[1];

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        return decodedToken; // { uid, email, ... } 등이 포함된 객체 반환
    } catch (error) {
        console.error("토큰 검증 실패:", error);
        throw new Error('유효하지 않은 토큰입니다. (Invalid token)');
    }
};

// ==================================================================
// 1. [신규 API] 사용자 프로필 조회 함수
// ==================================================================
exports.getUserProfile = functions.runWith({ secrets: ["OPENAI_API_KEY"] }).https.onRequest(async (request, response) => {
    response.set('Access-Control-Allow-Origin', '*');
    response.set('Access-Control-Allow-Methods', 'GET, POST'); // POST로도 확인 요청을 받을 수 있도록
    response.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (request.method === 'OPTIONS') {
        response.status(204).send('');
        return;
    }

    try {
        // 1. 요청 보낸 사용자 인증
        const user = await getAuthenticatedUser(request);
        const userId = user.uid;

        // 2. Firestore에서 해당 사용자 문서 조회
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileSnap = await userProfileRef.get();

        // 3. 분기 처리
        if (userProfileSnap.exists) {
            // 프로필이 존재하면: "found" 상태와 프로필 데이터 반환
            response.status(200).json({
                status: 'found',
                profile: userProfileSnap.data()
            });
        } else {
            // 프로필이 없으면: "not_found" 상태 반환 (클라이언트가 이 응답을 보고 프로필 설정 폼을 띄움)
            response.status(200).json({
                status: 'not_found'
            });
        }
    } catch (error) {
        if (error.message.includes('토큰')) {
            response.status(401).json({ status: "error", message: error.message });
        } else {
            response.status(500).json({ status: "error", message: "서버 내부 오류", details: error.message });
        }
    }
});

// ==================================================================
// 2. [신규 API] 사용자 프로필 생성/업데이트 함수
// ==================================================================
exports.createUserProfile = functions.runWith({ secrets: ["OPENAI_API_KEY"] }).https.onRequest(async (request, response) => {
    response.set('Access-Control-Allow-Origin', '*');
    response.set('Access-Control-Allow-Methods', 'POST');
    response.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (request.method === 'OPTIONS') {
        response.status(204).send('');
        return;
    }
    
    if (request.method !== 'POST') {
        return response.status(405).send('Only POST requests are allowed.');
    }

    try {
        // 1. 요청 보낸 사용자 인증
        const user = await getAuthenticatedUser(request);
        const userId = user.uid;

        // 2. 클라이언트가 보낸 프로필 데이터 추출
        // (우리가 논의했던 그 구조: { readingProfile, knownTopics })
        const { readingProfile, knownTopics } = request.body;

        if (!readingProfile || !knownTopics) {
            return response.status(400).send('Invalid profile data.');
        }

        const profileData = {
            readingProfile: readingProfile,
            knownTopics: knownTopics,
            email: user.email, // 사용자 이메일도 함께 저장
            displayName: user.name || null, // 사용자 이름도 함께 저장
            updatedAt: admin.firestore.FieldValue.serverTimestamp() // 업데이트 시간 기록
        };

        // 3. Firestore에 데이터 저장 (set, merge: true)
        // set + merge:true = 문서가 없으면 새로 만들고, 있으면 이 필드만 덮어씀 (업데이트)
        const userProfileRef = db.collection('users').doc(userId);
        await userProfileRef.set(profileData, { merge: true });

        response.status(201).json({
            status: 'success',
            message: 'Profile created/updated successfully.',
            profile: profileData
        });

    } catch (error) {
        if (error.message.includes('토큰')) {
            response.status(401).json({ status: "error", message: error.message });
        } else {
            response.status(500).json({ status: "error", message: "서버 내부 오류", details: error.message });
        }
    }
});

// ==================================================================
// 3. [신규] 텍스트 순화 API (1단계: 순화 결과 즉시 반환)
// ==================================================================
exports.simplifyText = functions.runWith({ secrets: ["OPENAI_API_KEY"] }).https.onRequest(async (request, response) => {
    response.set('Access-Control-Allow-Origin', '*');
    response.set('Access-Control-Allow-Methods', 'POST');
    response.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (request.method === 'OPTIONS') {
        response.status(204).send('');
        return;
    }

    if (request.method !== 'POST') {
        return response.status(405).send('Only POST requests are allowed.');
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    try {
        const user = await getAuthenticatedUser(request);
        const userId = user.uid;
        const userProfileSnap = await db.collection('users').doc(userId).get();

        if (!userProfileSnap.exists) {
            return response.status(404).json({ status: "error", message: "프로필이 없습니다. 먼저 프로필을 설정해주세요." });
        }
        
        const userProfile = userProfileSnap.data();
        const { title, paragraphs } = request.body;

        if (!title || !paragraphs || !Array.isArray(paragraphs)) {
            return response.status(400).send('Invalid request data.');
        }

        const guidelineSentences = [];
        if (userProfile.readingProfile && userProfile.readingProfile.includes('문장')) {
            guidelineSentences.push('사용자는 긴 문장을 읽는 데 어려움을 느끼므로, 문장을 짧고 간결하게 나누어주세요.');
        }
        if (userProfile.readingProfile && userProfile.readingProfile.includes('어휘')) {
            guidelineSentences.push('사용자는 어려운 한자어, 외래어, 전문 용어에 익숙하지 않으니, 이를 쉬운 단어로 풀어서 설명해주세요.');
        }

        const simplificationGuidelines = `
            - 읽기 프로필: ${guidelineSentences.join(' ')}
            - 자신 있는 분야: [${userProfile.knownTopics.join(', ')}]
        `;
        
        const originalFullText = paragraphs.map(p => p.text).join('\\n\\n');

        // --- 1단계: 텍스트 순화 요청 ---
        const promptForSimplification = `
            ## 역할 (Persona)
            당신은 전문 편집자입니다. 사용자의 프로필을 바탕으로 원문 텍스트를 맞춤형으로 순화하세요.

            ## 사용자 프로필
            ${simplificationGuidelines}

            ## 지침
            - 사용자의 읽기 수준에 맞춰 문장의 난이도를 조절하세요.
            - 단, 본문의 주제가 사용자가 '자신 있는 분야' 목록에 포함될 경우, 전문 용어를 굳이 순화하지 말고 그대로 사용하세요.
            - 원문의 핵심 의미를 절대 왜곡하지 마세요.
            - 원문이 한국어이므로, 결과물도 반드시 한국어로 작성하세요.

            ## 원문 텍스트 (Original Text)
            ---
            ${originalFullText}
            ---
        `;

        const simplificationCompletion = await openai.chat.completions.create({
            model: "gpt-4-turbo",
            messages: [
                {"role": "system", "content": "You are an expert editor that returns only a single, valid JSON object."},
                {"role": "user", "content": promptForSimplification}
            ],
            tools: [{
                type: "function",
                function: {
                    name: "simplify_text",
                    description: "Rewrites text paragraphs based on user feedback.",
                    parameters: {
                        type: "object",
                        properties: {
                            simplified_paragraphs: {
                                type: "array",
                                description: "The list of simplified paragraphs, maintaining original IDs.",
                                items: {
                                    type: "object",
                                    properties: {
                                        id: { type: "integer", description: "The original paragraph ID." },
                                        text: { type: "string", description: "The simplified paragraph text." }
                                    },
                                    required: ["id", "text"]
                                }
                            }
                        },
                        required: ["simplified_paragraphs"]
                    }
                }
            }],
            tool_choice: { type: "function", function: { name: "simplify_text" } },
        });

        const simpliToolCall = simplificationCompletion.choices[0].message.tool_calls?.[0];
        if (!simpliToolCall || !simpliToolCall.function.arguments) {
            return response.status(500).json({ status: "error", message: "AI 모델이 유효한 순화 결과를 생성하지 못했습니다." });
        }

        const result = JSON.parse(simpliToolCall.function.arguments);
        const simplifiedParagraphs = result.simplified_paragraphs || [];
        const simplifiedFullText = simplifiedParagraphs.map(p => p.text).join('\\n\\n');

        // --- 2단계: 작업 생성 및 클라이언트에게 즉시 응답 ---
        const jobId = crypto.randomBytes(16).toString('hex');
        const jobRef = db.collection('simplificationJobs').doc(jobId);

        await jobRef.set({
            userId: userId,
            status: 'processing',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            originalText: originalFullText,
            simplifiedText: simplifiedFullText,
        });

        // 클라이언트에게 순화된 텍스트와 작업 ID를 즉시 반환
        response.status(200).json({
            status: "processing",
            jobId: jobId,
            data: {
                title: title,
                simplified_paragraphs: simplifiedParagraphs,
            }
        });

        // --- 3단계: 백그라운드에서 리포트 생성 및 저장 ---
        // 이 함수는 await 하지 않음으로써 백그라운드에서 실행되도록 함
        const generateAndSaveReport = async () => {
            try {
                const promptForReport = `
                    ## 역할 (Persona)
                    당신은 언어 분석가입니다. 주어진 원문과 순화된 글을 비교하여 객관적인 분석 리포트를 JSON 형태로 제출하세요.

                    ## 분석 지침
                    - 원문과 순화된 글의 어휘 수준을 각각 평가하세요. (예: '대학생 수준')
                    - AI가 판단하는 가독성 향상 점수를 1점에서 100점 사이로 매기세요.
                    - 순화를 위해 수행한 가장 중요한 작업 3가지를 '요약'하여 배열로 제공하세요.

                    ## 원문
                    ---
                    ${originalFullText}
                    ---

                    ## 순화된 글
                    ---
                    ${simplifiedFullText}
                    ---
                `;

                const reportCompletion = await openai.chat.completions.create({
                    model: "gpt-4-turbo",
                    messages: [
                        {"role": "system", "content": "You are an expert analyst that returns only a single, valid JSON object."},
                        {"role": "user", "content": promptForReport}
                    ],
                    tools: [{
                        type: "function",
                        function: {
                            name: "provide_analysis_report",
                            description: "Provides an analysis report comparing original and simplified text.",
                            parameters: {
                                type: "object",
                                properties: {
                                    analysis_report: {
                                        type: "object",
                                        properties: {
                                            vocabulary_level_original: { type: "string" },
                                            vocabulary_level_simplified: { type: "string" },
                                            readability_improvement_score: { type: "integer" },
                                            key_simplifications: { type: "array", items: { type: "string" } }
                                        },
                                        required: ["vocabulary_level_original", "vocabulary_level_simplified", "readability_improvement_score", "key_simplifications"]
                                    }
                                },
                                required: ["analysis_report"]
                            }
                        }
                    }],
                    tool_choice: { type: "function", function: { name: "provide_analysis_report" } },
                });

                const reportToolCall = reportCompletion.choices[0].message.tool_calls?.[0];
                if (reportToolCall && reportToolCall.function.arguments) {
                    const reportResult = JSON.parse(reportToolCall.function.arguments);
                    const quantitativeReport = {
                        original_char_count: originalFullText.length,
                        simplified_char_count: simplifiedFullText.length,
                    };

                    await jobRef.update({
                        status: 'completed',
                        analysis: {
                            ...reportResult.analysis_report,
                            quantitative: quantitativeReport
                        }
                    });
                } else {
                    throw new Error("AI 모델이 유효한 리포트를 생성하지 못했습니다.");
                }
            } catch (error) {
                console.error(`[Job ID: ${jobId}] 리포트 생성 실패:`, error);
                await jobRef.update({ status: 'failed', error: error.message });
            }
        };

        generateAndSaveReport(); // await 없이 호출하여 백그라운드 실행

    } catch (error) {
        console.error("API call failed or processing error:", error);
        if (error.message.includes('토큰')) {
            response.status(401).json({ status: "error", message: error.message });
        } else {
            response.status(500).json({ status: "error", message: "서버 내부 오류", details: error.message });
        }
    }
});

// ==================================================================
// 4. [신규] 순화 리포트 조회 API (2단계: 생성된 리포트 조회)
// ==================================================================
exports.getSimplificationReport = functions.https.onRequest(async (request, response) => {
    response.set('Access-Control-Allow-Origin', '*');
    response.set('Access-Control-Allow-Methods', 'GET');
    response.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (request.method === 'OPTIONS') {
        response.status(204).send('');
        return;
    }

    try {
        await getAuthenticatedUser(request); // 사용자 인증
        const jobId = request.query.jobId;

        if (!jobId) {
            return response.status(400).json({ status: 'error', message: 'jobId가 필요합니다.' });
        }

        const jobRef = db.collection('simplificationJobs').doc(jobId);
        const jobSnap = await jobRef.get();

        if (!jobSnap.exists) {
            return response.status(404).json({ status: 'error', message: '해당 작업을 찾을 수 없습니다.' });
        }

        const jobData = jobSnap.data();

        if (jobData.status === 'completed') {
            response.status(200).json({
                status: 'completed',
                analysis: jobData.analysis
            });
        } else if (jobData.status === 'processing') {
            response.status(202).json({ status: 'processing', message: '리포트가 아직 생성 중입니다. 잠시 후 다시 시도해주세요.' });
        } else {
            response.status(500).json({ status: 'failed', message: '리포트 생성에 실패했습니다.', details: jobData.error });
        }

    } catch (error) {
        console.error("Report retrieval failed:", error);
        if (error.message.includes('토큰')) {
            response.status(401).json({ status: "error", message: error.message });
        } else {
            response.status(500).json({ status: "error", message: "서버 내부 오류", details: error.message });
        }
    }
});
