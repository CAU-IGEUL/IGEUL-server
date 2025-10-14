// Firebase Functions 및 Node.js의 기본 모듈 호출
const functions = require('firebase-functions');
const crypto = require('crypto'); // 텍스트 고유 해시 생성을 위한 모듈
const { OpenAI } = require('openai'); // OpenAI 라이브러리

/**
 * 프론트엔드로부터 본문을 받아 사전 질문을 생성하여 반환하는 HTTP 함수입니다.
 */
exports.analyzeQuestions = functions.runWith({ secrets: ["OPENAI_API_KEY"] }).https.onRequest(async (request, response) => {
    // CORS 설정: 모든 출처에서의 요청을 허용 (개발용)
    // TODO: 프로덕션에서는 'chrome-extension://<YOUR_EXTENSION_ID>'와 같이 특정 출처만 허용하는 것이 안전합니다.
    response.set('Access-Control-Allow-Origin', '*');
    response.set('Access-Control-Allow-Methods', 'GET, POST');
    response.set('Access-Control-Allow-Headers', 'Content-Type');

    // Preflight 요청(OPTIONS) 처리
    if (request.method === 'OPTIONS') {
        response.status(204).send('');
        return;
    }
    
    // 1. OpenAI 클라이언트를 함수 내부에서 초기화합니다.
    const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
    });

    if (request.method !== 'POST') {
        return response.status(405).send('Only POST requests are allowed.');
    }

    // 요청 본문에서 데이터 추출 및 유효성 검사
    const { url, title, paragraphs } = request.body;
    if (!url || !title || !paragraphs || !Array.isArray(paragraphs)) {
        return response.status(400).send('Invalid request data: Missing required fields.');
    }

    try {
        const fullText = paragraphs.map(p => p.text).join('\n\n');
        const originalTextHash = crypto.createHash('sha256').update(fullText).digest('hex');

        // 2. 프롬프트 작성 (사용자가 수정한 최종 버전)
        const promptContent = `
        ## 역할 (Persona)
        당신은 사용자의 학습 경험을 설계하는 교육 설계 전문가입니다. 당신의 목표는 주어진 텍스트를 사용자가 더 쉽게 이해할 수 있도록, 사용자의 사전 지식과 읽기 선호도를 파악하는 통찰력 있는 Yes/No 질문 3개를 만드는 것입니다.

        ## 임무 (Task)
        아래 텍스트를 분석하여, 사용자의 이해를 돕기 위한 Yes/No 질문 3개를 아래 규칙에 따라 JSON 형식으로 생성하세요.

        ## 규칙 (Rules)
        1.  **첫 번째 질문 (세부 주제, 포괄적 주제, 글의 종류 파악):**
            - 글에서 세부 주제, 포괄적 주제, 글의 종류를 추출하세요.
            - **추출 조건:** 세부 주제와 포괄적 주제는 각각 **10자 이내**의 명사로 간결하게 추출해야 합니다.
            - **질문 형식:** 반드시 다음 형식을 정확히 따라야 합니다. '{세부주제}에 관한 {글의 종류}입니다. {포괄주제}에 대한 기본 지식이 있나요?'
            - **예시:** "React(세부주제)에 관한 기술 문서(글의 종류)입니다. 웹 개발(포괄주제)에 대한 기본 지식이 있나요?"

        2.  **두 번째 질문 (핵심/어려운 단어 파악):**
            - 본문에서 독자가 어려워할 만한 핵심 전문 용어 1~2개를 식별하세요.
            - 해당 용어에 대한 기본 지식이 있는지 직접적으로 질문하세요.
            - **예시:** "본문에 나오는 'API'라는 용어에 대해 알고 계신가요?"

        3.  **세 번째 질문 (글의 짜임 분석 및 순화 제안):**
            - 아래 우선순위에 따라 글의 구조와 스타일을 분석하고, **가장 두드러지는 특징 하나만**을 선택하여 질문을 생성하세요.
            - **1순위 (긴 문장):** 30단어 이상 사용된 문장이 텍스트 전체의 30% 이상을 차지하는지 확인하세요. 그렇다면, "이 글은 30단어 이상의 긴 문장이 많습니다. 더 짧고 간결한 문장으로 나누어 드릴까요?"라고 질문하세요.
            - **2순위 (수사적 표현):** 1순위에 해당하지 않고, 비유나 은유 등 수사적인 표현이 3개 이상 발견되면, "글에 비유적인 표현이 다소 사용되었습니다. 더 직설적인 설명으로 수정해 드릴까요?"라고 질문하세요.
            - **3순위 (기타 구조):** 1, 2순위에 해당하지 않으면, 문단 길이, 핵심 내용의 전개 방식 등 다른 구조적 특징을 분석하여 개선점을 제안하세요. (예: "각 문단이 다소 깁니다. 핵심 내용 위주로 요약해 드릴까요?")

        ## 제약 조건 (Constraints)
        - 반드시 3개의 질문을 생성해야 합니다.
        - 모든 질문은 반드시 '예' 또는 '아니오'로 답변할 수 있어야 합니다.
        - 질문은 반드시 본문의 구체적인 내용이나 스타일에 기반해야 합니다. 추상적이거나 일반적인 질문은 생성하지 마세요.

        ## 분석할 본문
        ---
        ${fullText}
        ---
    `;
        
        // 3. OpenAI API 호출
        const completion = await openai.chat.completions.create({
            model: "gpt-4-turbo",
            messages: [
                {"role": "system", "content": "You are a helpful assistant that outputs only a single, valid JSON object."},
                {"role": "user", "content": promptContent},
            ],
            tools: [{
                type: "function",
                function: {
                    name: "generate_preliminary_questions",
                    description: "Generate preliminary questions for a user based on text analysis.",
                    parameters: {
                        type: "object",
                        properties: {
                            questions: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        id: { type: "integer", description: "Unique ID for the question (1, 2, 3...)" },
                                        text: { type: "string", description: "The Yes/No question text." },
                                        type: { type: "string", description: "The type of question.", enum: ["topic_and_scope", "terminology", "style_and_structure"] }
                                    },
                                    required: ["id", "text", "type"]
                                }
                            }
                        },
                        required: ["questions"]
                    }
                }
            }],
            tool_choice: { type: "function", function: { name: "generate_preliminary_questions" } },
            temperature: 0.7,
        });

        // 4. 모델 응답 처리 및 결과 구조화
        const toolCall = completion.choices[0].message.tool_calls?.[0];
        if (!toolCall || !toolCall.function.arguments) {
            console.error("OpenAI did not return the expected tool call.", completion.choices[0]);
            return response.status(500).json({ error: "Failed to get a valid response from the AI model." });
        }
        
        const generatedQuestionsArgs = JSON.parse(toolCall.function.arguments); 
        
        const finalResponse = {
            questions: generatedQuestionsArgs.questions || [],
            original_text_hash: originalTextHash,
            message: "Successfully generated preliminary questions."
        };

        // 5. 성공 응답 반환
        response.status(200).json(finalResponse);

    } catch (error) {
        console.error("API call failed or processing error:", error);
        response.status(500).json({
            error: "Failed to process request. Check server logs.",
            details: error.message
        });
    }
});


/**
 * 사용자의 답변과 원문을 받아, 본문을 맞춤형으로 순화하여 반환하는 HTTP 함수입니다.
 */
exports.simplifyContents = functions.runWith({ secrets: ["OPENAI_API_KEY"] }).https.onRequest(async (request, response) => {
    // CORS 설정
    response.set('Access-Control-Allow-Origin', '*');
    response.set('Access-Control-Allow-Methods', 'GET, POST');
    response.set('Access-Control-Allow-Headers', 'Content-Type');

    // Preflight 요청(OPTIONS) 처리
    if (request.method === 'OPTIONS') {
        response.status(204).send('');
        return;
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY });

    if (request.method !== 'POST') {
        return response.status(405).send('Only POST requests are allowed.');
    }

    // 1. 요청 본문에서 데이터 추출 및 유효성 검사
    const { user_answers, title, paragraphs } = request.body;
    if (!user_answers || !Array.isArray(user_answers) || !title || !paragraphs || !Array.isArray(paragraphs)) {
        return response.status(400).send('Invalid request data: Missing or malformed required fields.');
    }

    try {
        // 2. 사용자 답변을 AI가 이해할 수 있는 구체적인 지침으로 변환
        const simplificationGuidelines = user_answers.map(item => {
            if (item.id === 1) { // 주제 및 범위 지식
                return item.answer 
                    ? "사용자는 글의 전반적인 주제에 익숙하므로, 전문성을 유지하되 문장을 더 명확하게 다듬어주세요." 
                    : "사용자가 주제에 익숙하지 않습니다. 더 쉽고 명확한 단어를 사용하고, 필요하다면 간단한 비유를 들어 핵심 개념을 설명해주세요.";
            } else if (item.id === 2) { // 전문 용어 지식
                return item.answer 
                    ? "사용자는 전문 용어에 익숙하므로, 용어를 그대로 사용해도 좋습니다." 
                    : "사용자가 전문 용어를 모릅니다. 어려운 용어는 더 쉬운 말로 대체하거나 괄호 안에 짧은 설명을 덧붙여 주세요.";
            } else if (item.id === 3) { // 문체 및 구조 선호도
                return item.answer 
                    ? "사용자는 현재 글의 스타일에 큰 거부감이 없습니다. 자연스러운 흐름을 유지하며 가독성을 개선해주세요." 
                    : "사용자가 글의 구조/스타일 변경을 원합니다. 긴 문장은 짧게 나누고, 비유적 표현은 직설적으로 바꾸는 등 글을 더 간결하고 명확하게 재구성해주세요.";
            }
            return null;
        }).filter(Boolean).join('\n- ');

        // 3. AI에게 전달할 프롬프트 구성
        const fullText = paragraphs.map(p => p.text).join('\n\n');
        const promptContent = `
            ## 역할 (Persona)
            당신은 전문 편집자입니다. 당신의 임무는 사용자의 구체적인 피드백을 반영하여 주어진 텍스트를 훨씬 이해하기 쉽게 재작성하는 것입니다.

            ## 임무 (Task)
            아래의 [사용자 피드백]과 [원문 텍스트]를 참고하여, 원문의 의미를 보존하면서 각 문단을 순화하세요. 최종 결과물은 반드시 [출력 형식]에 맞는 JSON 객체여야 합니다.

            ## 사용자 피드백
            - ${simplificationGuidelines}

            ## 핵심 규칙 (CRITICAL RULE)
            1.  **언어 유지 (Language Maintenance)**: 원문이 한국어이므로, 순화된 결과물도 반드시 한국어로 작성해야 합니다. 절대로 다른 언어로 번역하지 마세요.
            2.  **의미 보존**: 원문의 핵심 정보나 본래 의미를 절대 왜곡하거나 훼손해서는 안 됩니다. 새로운 정보를 추가하거나 중요한 사실을 생략하지 마세요.
            3.  **문단 구조 유지**: 원문의 문단 개수와 순서를 반드시 그대로 유지해야 합니다. 각 문단은 독립적으로 순화하여, 원래의 문단 ID에 맞춰 결과를 생성해주세요.

            ## 원문 텍스트 (Original Text)
            ---
            ${fullText}
            ---
        `;

        // 4. OpenAI API 호출
        const completion = await openai.chat.completions.create({
            model: "gpt-4-turbo",
            messages: [
                {"role": "system", "content": "You are an expert editor that returns only a single, valid JSON object according to the user's request."},
                {"role": "user", "content": promptContent}
            ],
            tools: [{
                type: "function",
                function: {
                    name: "simplify_the_text",
                    description: "Rewrites the provided text paragraphs based on user feedback.",
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
            tool_choice: { type: "function", function: { name: "simplify_the_text" } },
        });

        // 5. 모델 응답 처리 및 클라이언트에 반환
        const toolCall = completion.choices[0].message.tool_calls?.[0];
        if (!toolCall || !toolCall.function.arguments) {
            console.error("OpenAI did not return the expected tool call.", completion.choices[0]);
            return response.status(500).json({ 
                status: "error",
                message: "AI 모델이 유효한 응답을 생성하지 못했습니다." 
            });
        }

        const result = JSON.parse(toolCall.function.arguments);
        const finalResponse = {
            status: "success",
            data: {
                title: title,
                simplified_paragraphs: result.simplified_paragraphs || []
            }
        };

        response.status(200).json(finalResponse);

    } catch (error) {
        console.error("API call failed or processing error:", error);
        response.status(500).json({
            status: "error",
            message: "요청을 처리하는 중 서버에서 오류가 발생했습니다.",
            details: error.message
        });
    }
});

