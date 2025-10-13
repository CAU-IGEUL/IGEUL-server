// Firebase Functions 및 Node.js의 기본 모듈 호출
const functions = require('firebase-functions');
const crypto = require('crypto'); // 텍스트 고유 해시 생성을 위한 모듈
const { OpenAI } = require('openai'); // OpenAI 라이브러리

/**
 * 프론트엔드로부터 본문을 받아 사전 질문을 생성하여 반환하는 HTTP 함수입니다.
 */
exports.analyzeQuestions = functions.runWith({ secrets: ["OPENAI_API_KEY"] }).https.onRequest(async (request, response) => {

    // 1. OpenAI 클라이언트를 함수 내부에서 초기화합니다. (지연 초기화)
    const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY, // Secret이 로드된 후 접근
    });

    // CORS 설정: 크롬 확장 프로그램 요청 허용
    response.set('Access-Control-Allow-Origin', '*'); 

    if (request.method !== 'POST') {
        return response.status(405).send('Only POST requests are allowed.');
    }

    // 요청 본문에서 데이터 추출
    const { url, title, paragraphs } = request.body;

    // 데이터 유효성 검사
    if (!url || !title || !paragraphs || !Array.isArray(paragraphs)) {
        return response.status(400).send('Invalid request data: Missing required fields.');
    }

    try {
        // 1. 본문 텍스트 병합 및 고유 해시 생성 (3단계에서 원문 추적용)
        const fullText = paragraphs.map(p => p.text).join('\n\n');
        // SHA256 해시로 텍스트의 고유 식별자 생성
        const originalTextHash = crypto.createHash('sha256').update(fullText).digest('hex');

        // 2. 프롬프트 작성 (한국어 버전)
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
            model: "gpt-3.5-turbo-1106", // JSON 출력이 안정적인 모델 권장
            messages: [
                {"role": "system", "content": "You are a helpful assistant that outputs only a JSON object."},
                {"role": "user", "content": promptContent},
            ],

            // 모델이 출력할 JSON 스키마를 명시하여 정확도를 높입니다.
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
                                        type: {
                                            type: "string",
                                            description: "The type of question.",
                                            enum: ["topic_and_scope", "terminology", "style_and_structure"] 
                                        }
                                    },
                                    required: ["id", "text", "type"]
                                },
                        }
                        },
                        required: ["questions"]
                    }
                }
            }],
            tool_choice: { type: "function", function: { name: "generate_preliminary_questions" } },
            temperature: 0.7,
            max_tokens: 1000, 
        });

        // 4. 모델 응답 처리 및 결과 구조화
        const toolCall = completion.choices[0].message.tool_calls[0];
        // JSON 문자열을 파싱
        const generatedQuestionsArgs = JSON.parse(toolCall.function.arguments); 
        
        // 최종 응답 데이터 구성
        const finalResponse = {
            questions: generatedQuestionsArgs.questions || [],
            original_text_hash: originalTextHash,
            message: "Successfully generated preliminary questions."
        };

        // 5. 성공 응답 반환
        response.status(200).json(finalResponse);

    } catch (error) {
        console.error("API call failed or processing error:", error);
        // 에러 발생 시 500 (Internal Server Error) 반환
        response.status(500).json({
            error: "Failed to process request. Check server logs.",
            details: error.message
        });
    }
});