// Firebase Functions 및 Node.js의 기본 모듈 호출
const functions = require('firebase-functions');
const crypto = require('crypto'); // 텍스트 고유 해시 생성을 위한 모듈
const { OpenAI } = require('openai'); // OpenAI 라이브러리

// 1. OpenAI 클라이언트 초기화
// 환경 변수(Secret)는 process.env를 통해 접근하며, 이를 통해 안전하게 키를 불러옵니다.
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

/**
 * 프론트엔드로부터 본문을 받아 사전 질문을 생성하여 반환하는 HTTP 함수입니다.
 */
exports.analyzeQuestions = functions.https.onRequest(async (request, response) => {
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

        // 2. 프롬프트 작성
        const promptContent = `
            당신은 사용자의 글 읽기 이해도를 높이는 보조 AI입니다.
            제공된 텍스트를 분석하여, 다음 3가지 유형의 질문을 포함하는 최대 3개의 Yes/No 형식의 질문을 생성하세요.
            1. 글의 주제에 관한 사전 지식 여부
            2. 텍스트의 난이도에 대한 사용자의 가독 능력 여부 (긴 문장, 복잡한 구조)
            3. 텍스트 이해에 필요한 배경 지식 여부 (예: 특정 전문 용어, 한자어 등)

            [본문 텍스트]:
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
            // JSON 출력을 강제하는 설정
            response_format: { type: "json_object" }, 
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
                                description: "A list of 1 to 3 Yes/No questions for the user.",
                                items: {
                                    type: "object",
                                    properties: {
                                        id: { type: "integer", description: "Unique ID for the question (1, 2, 3...)" },
                                        text: { type: "string", description: "The Yes/No question text." }
                                    },
                                    required: ["id", "text"]
                                }
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