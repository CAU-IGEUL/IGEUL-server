// functions/api/simplification.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const crypto = require('crypto');
const { OpenAI } = require('openai');

const { getAuthenticatedUser } = require('../utils/auth');
const { analyzeText } = require('../utils/analysis');

const db = admin.firestore();

// ==================================================================
// 3. [API] 텍스트 순화 및 정량적 리포트 생성 API
// ==================================================================
const simplifyText = functions.runWith({ secrets: ["OPENAI_API_KEY"] }).https.onRequest(async (request, response) => {
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
        const readingProfile = userProfile.readingProfile || {};

        // 문장 가이드라인
        if (readingProfile.sentence) {
            switch (readingProfile.sentence) {
                case 1:
                    guidelineSentences.push('긴 문장을 여러 개의 짧은 문장으로 나눠주세요.');
                    break;
                case 2:
                    guidelineSentences.push('긴 문장을 짧게 나누고, 복잡한 문장 구조(예: 종속절, 관계절)를 더 이해하기 쉬운 단순한 형태로 재구성해주세요.');
                    break;
            }
        }

        // 어휘 가이드라인
        if (readingProfile.vocabulary) {
            switch (readingProfile.vocabulary) {
                case 1:
                    guidelineSentences.push('어려운 한자어나 외래어를 쉬운 우리말로 바꿔주세요.');
                    break;
                case 2:
                    guidelineSentences.push('어려운 한자어/외래어를 쉬운 말로 바꾸고, 일상적으로 쓰이지 않는 전문 용어나 관용구를 풀어서 설명해주세요.');
                    break;
                case 3:
                    guidelineSentences.push('어려운 어휘, 전문 용어, 관용구를 쉬운 말로 바꾸고, 추상적이거나 비유적인 표현을 더 명확하고 직설적인 의미로 해석하여 전달해주세요.');
                    break;
            }
        }

        const simplificationGuidelines = `
            - 읽기 프로필: ${guidelineSentences.join(' ')}
            - 자신 있는 분야: [${userProfile.knownTopics.join(', ')}]
        `;
        
        const originalFullText = paragraphs.map(p => p.text).join('\n\n');

        // --- 1단계: 텍스트 순화 요청 ---
        const promptForSimplification = `
            ## 역할 (Persona)
            당신은 전문 편집자입니다. 사용자의 프로필을 바탕으로 원문 텍스트를 '순화'하는 임무를 맡았습니다. '요약'이 아님에 주의하세요.

            ## 사용자 프로필
            ${simplificationGuidelines}

            ## 지침
            - **문단 구조 유지**: 원문의 문단 개수와 순서를 반드시 유지하세요. 각 문단은 개별적으로 순화되어야 합니다.
            - **정보량 보존**: 원문의 핵심 정보와 세부 사항을 생략하거나 요약하지 마세요. 글의 길이를 인위적으로 줄이는 것이 목표가 아닙니다.
            - **어휘 및 문장 구조 순화**: 어려운 단어는 쉬운 말로 바꾸고, 복잡하고 긴 문장은 더 짧고 명확한 여러 문장으로 나누는 데 집중하세요.
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
        const simplifiedFullText = simplifiedParagraphs.map(p => p.text).join('\n\n');

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

        response.status(200).json({
            status: "processing",
            jobId: jobId,
            data: {
                title: title,
                simplified_paragraphs: simplifiedParagraphs,
            }
        });

        // --- 3단계: 백그라운드에서 정량적 리포트 생성 및 저장 ---
        const generateAndSaveReport = async () => {
            try {
                const originalAnalysis = analyzeText(originalFullText);
                const simplifiedAnalysis = analyzeText(simplifiedFullText);

                const charCountReduction = originalAnalysis.charCount > 0 
                    ? (originalAnalysis.charCount - simplifiedAnalysis.charCount) / originalAnalysis.charCount 
                    : 0;
                
                const readabilityImprovement = originalAnalysis.readabilityScore > 0
                    ? (originalAnalysis.readabilityScore - simplifiedAnalysis.readabilityScore) / originalAnalysis.readabilityScore
                    : 0;

                const analysisReport = {
                    summary: {
                        readability_improvement_percent: (readabilityImprovement * 100).toFixed(1),
                        char_count_reduction_percent: (charCountReduction * 100).toFixed(1),
                        key_message: `텍스트가 약 ${Math.round(charCountReduction * 100)}% 짧아졌고, 읽기 쉬운 정도는 약 ${Math.round(readabilityImprovement * 100)}% 향상되었어요.`
                    },
                    quantitative_analysis: {
                        original: originalAnalysis,
                        simplified: simplifiedAnalysis,
                        improvements: {
                            char_count_reduction: charCountReduction,
                            word_count_reduction: originalAnalysis.wordCount > 0 
                                ? (originalAnalysis.wordCount - simplifiedAnalysis.wordCount) / originalAnalysis.wordCount 
                                : 0,
                            stopword_reduction_count: originalAnalysis.stopwordCount - simplifiedAnalysis.stopwordCount,
                            readability_improvement: readabilityImprovement,
                        }
                    }
                };

                await jobRef.update({
                    status: 'completed',
                    analysis: analysisReport
                });

            } catch (error) {
                console.error(`[Job ID: ${jobId}] 정량적 리포트 생성 실패:`, error);
                await jobRef.update({ status: 'failed', error: error.message });
            }
        };

        generateAndSaveReport();

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
// 4. [API] 순화 리포트 조회 API
// ==================================================================
const getSimplificationReport = functions.https.onRequest(async (request, response) => {
    response.set('Access-Control-Allow-Origin', '*');
    response.set('Access-Control-Allow-Methods', 'GET');
    response.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (request.method === 'OPTIONS') {
        response.status(204).send('');
        return;
    }

    try {
        await getAuthenticatedUser(request);
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

// ==================================================================
// 5. [NEW API] 텍스트 요약 API
// ==================================================================
const summarizeText = functions.runWith({ secrets: ["OPENAI_API_KEY"] }).https.onRequest(async (request, response) => {
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
        await getAuthenticatedUser(request);
        
        const { paragraphs } = request.body;

        if (!paragraphs || !Array.isArray(paragraphs)) {
            return response.status(400).send('Invalid request data.');
        }
        
        const originalFullText = paragraphs.map(p => p.text).join('\n\n');

        const promptForSummarization = `
            ## 역할 (Persona)
            당신은 전문 요약가입니다. 주어진 텍스트의 핵심 내용을 간결하게 요약하세요.

            ## 지침
            - 전체 텍스트의 핵심 아이디어와 가장 중요한 정보만을 추출하세요.
            - 결과물은 한 개의 문단으로 구성되어야 합니다.
            - **분량은 300자 내외로 맞춰주세요.**
            - 독자가 원문을 읽지 않아도 전체 내용의 개요를 파악할 수 있도록 작성하세요.
            - 원문이 한국어이므로, 결과물도 반드시 한국어로 작성하세요.

            ## 원문 텍스트 (Original Text)
            ---
            ${originalFullText}
            ---
        `;

        const summaryCompletion = await openai.chat.completions.create({
            model: "gpt-4-turbo",
            messages: [
                {"role": "system", "content": "You are an expert summarizer who writes concise and complete summaries."},
                {"role": "user", "content": promptForSummarization}
            ],
            max_tokens: 700, // 300자 내외의 완전한 문장을 위해 토큰 수 증가
        });

        const summaryText = summaryCompletion.choices[0].message.content;

        response.status(200).json({
            status: 'success',
            summary: summaryText.trim()
        });

    } catch (error) {
        console.error("API call failed or processing error:", error);
        if (error.message.includes('토큰')) {
            response.status(401).json({ status: "error", message: error.message });
        } else {
            response.status(500).json({ status: "error", message: "서버 내부 오류", details: error.message });
        }
    }
});

module.exports = {
    simplifyText,
    getSimplificationReport,
    summarizeText
};
