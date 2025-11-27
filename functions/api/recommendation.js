// functions/api/recommendation.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { OpenAI } = require('openai');
const cors = require('cors')({ origin: true });

const { getAuthenticatedUser } = require('../utils/auth');

const db = admin.firestore();

// ==================================================================
// 7. [API] 텍스트를 기반으로 '더 읽을 거리'를 추천합니다.
// ==================================================================
const getReadingRecommendations = functions.runWith({ secrets: ["OPENAI_API_KEY", "GOOGLE_CSE_API_KEY", "GOOGLE_CSE_CX"] })
    .https.onRequest((request, response) => {
        cors(request, response, async () => {
            if (request.method !== 'POST') {
                return response.status(405).send('Only POST requests are allowed.');
            }

            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
            const googleCseApiKey = process.env.GOOGLE_CSE_API_KEY;
            const googleCseCx = process.env.GOOGLE_CSE_CX;

            try {
                const user = await getAuthenticatedUser(request);
                const userId = user.uid;

                const { paragraphs } = request.body;

                if (!paragraphs || !Array.isArray(paragraphs) || paragraphs.some(p => typeof p.text !== 'string')) {
                    return response.status(400).json({ status: 'error', message: '유효한 paragraphs 배열이 필요합니다.' });
                }

                const fullText = paragraphs.map(p => p.text).join('\n\n');

                if (!fullText.trim()) {
                    return response.status(400).json({ status: 'error', message: '분석할 텍스트가 비어 있습니다.' });
                }

                // 1. OpenAI API를 사용하여 핵심 키워드 추출
                const keywordExtractionPrompt = `
                    You are an expert in Korean text analysis.
                    From the given Korean text, extract up to 5 core topics or keywords that best represent the content.
                    List them in order of importance.
                    Return the result as a JSON object: {"keywords": ["keyword1", "keyword2", ...]}.

                    ## Text to analyze:
                    ---
                    ${fullText}
                    ---
                `;

                const keywordCompletion = await openai.chat.completions.create({
                    model: "gpt-4-turbo",
                    messages: [
                        {"role": "system", "content": "You are an expert Korean text analyst that returns only a single JSON object."}, 
                        {"role": "user", "content": keywordExtractionPrompt}
                    ],
                    response_format: { type: "json_object" },
                });

                let keywords = [];
                try {
                    const responseContent = keywordCompletion.choices[0].message.content;
                    const parsedResponse = JSON.parse(responseContent);
                    if (parsedResponse && Array.isArray(parsedResponse.keywords)) {
                        keywords = parsedResponse.keywords;
                    }
                } catch (parseError) {
                    console.warn("Failed to parse keyword extraction response:", parseError);
                }

                if (keywords.length === 0) {
                    return response.status(404).json({ status: "error", message: "텍스트에서 핵심 키워드를 추출하지 못했습니다." });
                }

                // (Optional) Fetch user profile to get knownTopics and incorporate into search query
                const userProfileSnap = await db.collection('users').doc(userId).get();
                const userProfile = userProfileSnap.exists ? userProfileSnap.data() : { knownTopics: [] };
                const knownTopics = userProfile.knownTopics || [];

                // Combine keywords and known topics to form a comprehensive search query
                let searchQuery = [...new Set([...keywords, ...knownTopics])].join(' ');
                searchQuery += ' 기사'; // Add "article" to get more relevant results

                // 2. Google Custom Search API로 관련 기사 검색
                const googleSearchUrl = `https://www.googleapis.com/customsearch/v1?key=${googleCseApiKey}&cx=${googleCseCx}&q=${encodeURIComponent(searchQuery)}&num=5`; // Request up to 5 results
                
                const searchResponse = await fetch(googleSearchUrl);
                const searchData = await searchResponse.json();

                const recommendations = [];
                if (searchData.items && searchData.items.length > 0) {
                    for (const item of searchData.items) {
                        recommendations.push({
                            title: item.title,
                            link: item.link,
                            snippet: item.snippet
                        });
                    }
                }

                response.status(200).json({
                    status: 'success',
                    recommendations: recommendations
                });

            } catch (error) {
                console.error("API call failed or processing error in getReadingRecommendations:", error);
                if (error.message.includes('토큰')) {
                    response.status(401).json({ status: "error", message: error.message });
                } else {
                    response.status(500).json({ status: "error", message: "서버 내부 오류", details: error.message });
                }
            }
        });
    });

module.exports = {
    getReadingRecommendations
};
