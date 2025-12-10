const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// [1] 환경변수
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 

// [필수] 용량 제한 설정
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());

// 모델 매핑
const MODEL_MAPPING = {
  'gpt-4o': 'meta/llama-3.1-405b-instruct',
  'gpt-4': 'deepseek-ai/deepseek-v3.1-terminus',
  'gpt-4-turbo': 'deepseek-ai/deepseek-r1-0528',
  'gpt-3.5-turbo': 'meta/llama-3.1-70b-instruct',
  'gemini-pro': 'deepseek-ai/deepseek-r1' 
};

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Unified AI Proxy', port: PORT });
});

app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy'
  }));
  // Gemini 모델 목록
  models.push({ id: 'gemini-2.5-flash', object: 'model', owned_by: 'google' });
  models.push({ id: 'gemini-1.5-flash', object: 'model', owned_by: 'google' });
  models.push({ id: 'gemini-1.5-pro', object: 'model', owned_by: 'google' });
  
  res.json({ object: 'list', data: models });
});

// =================================================================
// 🚀 통합 채팅 처리 구간 (Native 변환 모드 적용)
// =================================================================
app.post('/v1/chat/completions', async (req, res) => {
  const { model, messages, temperature, max_tokens, stream } = req.body;

  // ---------------------------------------------------------------
  // [A] Gemini 처리 구간 (Google Native API 사용 - 검열 해제용)
  // ---------------------------------------------------------------
  if (model && model.toLowerCase().includes('gemini')) {
    if (!GEMINI_API_KEY) {
        console.error("Gemini API Key missing");
        return res.status(500).json({ error: "Gemini API Key is missing" });
    }

    try {
      console.log(`🔹 Gemini Request (Native Mode): ${model}`);

      // 1. 메시지 변환 (OpenAI -> Gemini Native Format)
      let systemInstruction = undefined;
      const contents = [];

      for (const msg of messages) {
          if (msg.role === 'system') {
              // 시스템 프롬프트 별도 분리
              systemInstruction = { parts: [{ text: msg.content }] };
          } else {
              // user/assistant -> user/model 변환
              const role = msg.role === 'assistant' ? 'model' : 'user';
              contents.push({
                  role: role,
                  parts: [{ text: msg.content }]
              });
          }
      }

      // 2. 요청 본문 구성 (검열 해제 설정 포함!)
      const nativeBody = {
          contents: contents,
          systemInstruction: systemInstruction, // 시스템 프롬프트 적용
          generationConfig: {
              temperature: temperature || 0.7,
              maxOutputTokens: max_tokens || 8192, // ⭐ 중요: OpenAI의 max_tokens를 여기로 매핑
              candidateCount: 1
          },
          // 🛡️ 안전 설정: 모든 검열 끄기 (BLOCK_NONE)
          safetySettings: [
              { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
          ]
      };

      // 3. Native 엔드포인트 URL 생성
      // model 이름이 'gemini-2.5-flash' 처럼 들어오면 그대로 사용
      const targetModel = model.startsWith('gemini') ? model : 'gemini-1.5-flash';
      const nativeUrl = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:streamGenerateContent?key=${GEMINI_API_KEY}`;

      // 4. 전송
      const response = await axios.post(nativeUrl, nativeBody, {
        headers: { 'Content-Type': 'application/json' },
        responseType: 'stream'
      });

      // 5. 스트림 변환 (Google Stream -> OpenAI Stream)
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      response.data.on('data', (chunk) => {
        try {
            const lines = chunk.toString().split('\n');
            for (const line of lines) {
                if (!line.trim()) continue;
                // 구글은 "data: " 접두사 없이 JSON 배열을 보냄 (보정 필요)
                let cleanLine = line.replace(/^data: /, '').trim();
                if (cleanLine === '[' || cleanLine === ']' || cleanLine === ',') continue; // 배열 괄호/콤마 무시

                // 구글 응답 파싱
                try {
                   const parsed = JSON.parse(cleanLine);
                   const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
                   
                   if (text) {
                       // OpenAI 포맷으로 변환하여 클라이언트에 전송
                       const openaiChunk = {
                           id: "chatcmpl-" + Date.now(),
                           object: "chat.completion.chunk",
                           created: Math.floor(Date.now() / 1000),
                           model: model,
                           choices: [{
                               index: 0,
                               delta: { content: text },
                               finish_reason: null
                           }]
                       };
                       res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
                   }
                } catch (e) {
                    // JSON 파싱 에러는 무시 (스트림 중간 끊김 등)
                }
            }
        } catch (e) {
            console.error("Stream parse error:", e);
        }
      });

      response.data.on('end', () => {
          res.write('data: [DONE]\n\n');
          res.end();
      });

    } catch (error) {
      console.error("Gemini Native Error:", error.message);
      if (error.response) {
          console.error("Error Detail:", JSON.stringify(error.response.data));
      }
      return res.status(500).json({ error: "Gemini Native API Error" });
    }
  } else {

  // ---------------------------------------------------------------
  // [B] NVIDIA 처리 구간
  // ---------------------------------------------------------------
  try {
    let nimModel = MODEL_MAPPING[model] || 'meta/llama-3.1-405b-instruct';

    // 요청 구성 (원본 유지)
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 1024,
      extra_body: ENABLE_THINKING_MODE ? { chat_template_kwargs: { thinking: true } } : undefined,
      stream: stream || false
    };

    console.log(`🔸 NVIDIA Request: ${nimModel}`);

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json',
      maxBodyLength: Infinity, 
      maxContentLength: Infinity 
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      response.data.pipe(res);
    } else {
      res.json(response.data);
    }

  } catch (error) {
    console.error('NVIDIA Proxy error:', error.message);
    if (error.response) {
        console.error('Error status:', error.response.status);
        console.error('Error data:', JSON.stringify(error.response.data).substring(0, 200));
    }

    res.status(error.response?.status || 500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'invalid_request_error',
        code: error.response?.status || 500
      }
    });
  }
});

app.all('*', (req, res) => {
  res.status(404).json({ error: { message: `Endpoint ${req.path} not found` } });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
