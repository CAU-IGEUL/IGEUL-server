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
// 3. [기존 API] 문장 순화 함수 (프로필 사용하도록 수정)
// ==================================================================
exports.simplifyContents = functions.runWith({ secrets: ["OPENAI_API_KEY"] }).https.onRequest(async (request, response) => {
    response.set('Access-Control-Allow-Origin', '*');
    response.set('Access-Control-Allow-Methods', 'POST');
    response.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (request.method === 'OPTIONS') {
        response.status(204).send('');
        return;
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    if (request.method !== 'POST') {
        return response.status(405).send('Only POST requests are allowed.');
    }

    try {
        // 1. ✨ 사용자 인증 (이제 필수!)
        const user = await getAuthenticatedUser(request);
        const userId = user.uid;

        // 2. ✨ Firestore에서 사용자 프로필 조회
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileSnap = await userProfileRef.get();

        if (!userProfileSnap.exists) {
            // 프로필이 없으면 순화를 진행할 수 없음
            return response.status(404).json({ status: "error", message: "프로필이 없습니다. 먼저 프로필을 설정해주세요." });
        }
        
        const userProfile = userProfileSnap.data();
        
        // 3. 요청 본문에서 텍스트 데이터 추출
        const { title, paragraphs } = request.body;
        if (!title || !paragraphs || !Array.isArray(paragraphs)) {
            return response.status(400).send('Invalid request data.');
        }
        
        // 4. ✨ DB에서 가져온 프로필을 반영하여 AI 프롬프트 생성
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
        
        const fullText = paragraphs.map(p => p.text).join('\\n\\n');

        // 5. 프롬프트 수정
        const promptContent = `
            ## 역할 (Persona)
            당신은 전문 편집자이자 언어 분석가입니다. 당신의 임무는 사용자의 개인 프로필을 바탕으로 텍스트를 맞춤형으로 순화하고, 그 '작업의 근거'를 객관적인 리포트로 제출하는 것입니다.

            ## 사용자 프로필
            ${simplificationGuidelines}

            ## 지침
            - 사용자의 읽기 수준에 맞춰 문장의 난이도를 조절하세요. (예: 'beginner'는 매우 쉽게)
            - 단, 본문의 주제가 사용자가 '자신 있는 분야' 목록에 포함될 경우, 전문 용어를 굳이 순화하지 말고 그대로 사용하세요.
            
            ## 핵심 규칙 (CRITICAL RULE)
            1.  **언어 유지**: 원문이 한국어이므로, 결과물도 반드시 한국어로 작성하세요.
            2.  **의미 보존**: 원문의 핵심 의미를 절대 왜곡하지 마세요.
            3.  **리포트 제출 (필수!)**: \`analysis_report\` 객체에 원문과 순화된 글을 비교 분석한 객관적인 데이터를 채워야 합니다.
                -   \`vocabulary_level_original\`: 원문의 어휘 수준 (예: '대학생 수준')
                -   \`vocabulary_level_simplified\`: 순화된 글의 어휘 수준 (예: '고등학생 수준')
                -   \`readability_improvement_score\`: AI가 판단하는 가독성 향상 점수 (1-100점).
                -   \`key_simplifications\`: 순화를 위해 수행한 가장 중요한 작업 3가지를 '요약'하여 배열로 제공

            ## 원문 텍스트 (Original Text)
            ---
            ${fullText}
            ---
        `;

        // 6. JSON 스키마 (이전과 동일, 리포트 포함)
        const completion = await openai.chat.completions.create({
            model: "gpt-4-turbo",
            messages: [
                {"role": "system", "content": "You are an expert editor and analyst that returns only a single, valid JSON object."},
                {"role": "user", "content": promptContent}
            ],
            tools: [{
                type: "function",
                function: {
                    name: "simplify_text_and_provide_report",
                    description: "Rewrites text paragraphs based on user feedback and provides an analysis report.",
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
                            },
                            analysis_report: {
                                type: "object",
                                description: "An objective analysis of the simplification process.",
                                properties: {
                                    vocabulary_level_original: { type: "string", description: "Estimated vocabulary level of the original text (e.g., 'University Level')." },
                                    vocabulary_level_simplified: { type: "string", description: "Estimated vocabulary level of the simplified text (e.g., 'High School Level')." },
                                    readability_improvement_score: { type: "integer", description: "Readability improvement score from 1 to 100." },
                                    key_simplifications: { 
                                        type: "array", 
                                        description: "A summary of the top 3 key changes made during simplification.",
                                        items: { type: "string" }
                                    }
                                },
                                required: ["vocabulary_level_original", "vocabulary_level_simplified", "readability_improvement_score", "key_simplifications"]
                            }
                        },
                        required: ["simplified_paragraphs", "analysis_report"]
                    }
                }
            }],
            tool_choice: { type: "function", function: { name: "simplify_text_and_provide_report" } },
        });

        // 7. 응답 처리 (이전과 동일, 정량적/정성적 리포트 포함)
        const toolCall = completion.choices[0].message.tool_calls?.[0];
        if (!toolCall || !toolCall.function.arguments) {
            console.error("OpenAI did not return the expected tool call.", completion.choices[0]);
            return response.status(500).json({ status: "error", message: "AI 모델이 유효한 응답을 생성하지 못했습니다." });
        }

        const result = JSON.parse(toolCall.function.arguments);
        
        const simplifiedFullText = result.simplified_paragraphs.map(p => p.text).join('\\n\\n');
        const quantitativeReport = {
            original_char_count: fullText.length,
            simplified_char_count: simplifiedFullText.length,
            // ... (기타 정량적 지표들) ...
        };
        
        const finalResponse = {
            status: "success",
            data: {
                title: title,
                simplified_paragraphs: result.simplified_paragraphs || [],
                analysis: {
                    ...result.analysis_report,
                    quantitative: quantitativeReport
                }
            }
        };

        response.status(200).json(finalResponse);

    } catch (error) {
        console.error("API call failed or processing error:", error);
        if (error.message.includes('토큰')) {
            response.status(401).json({ status: "error", message: error.message });
        } else {
            response.status(500).json({ status: "error", message: "서버 내부 오류", details: error.message });
        }
    }
});
