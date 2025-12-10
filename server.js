const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// [1] 환경변수 및 설정
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

const SHOW_REASONING = false;
const ENABLE_THINKING_MODE = false;

// 🔴 [필수] 용량 제한 설정
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());

// 모델 매핑
const MODEL_MAPPING = {
  'gpt-4o': 'meta/llama-3.1-405b-instruct',
  'gpt-4': 'deepseek-ai/deepseek-v3.1-terminus',
  'gpt-4-turbo': 'deepseek-ai/deepseek-r1-0528',
  'gpt-3.5-turbo': 'meta/llama-3.1-70b-instruct',
  'claude-3-opus': 'meta/llama-3.1-405b-instruct',
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
  // Gemini 모델 목록 추가
  models.push({ id: 'gemini-2.5-flash', object: 'model', owned_by: 'google' });
  models.push({ id: 'gemini-2.5-pro', object: 'model', owned_by: 'google' });
  models.push({ id: 'gemini-1.5-flash', object: 'model', owned_by: 'google' }); // 비상용 1.5 추가
  
  res.json({ object: 'list', data: models });
});

// =================================================================
// 🚀 통합 채팅 처리 구간
// =================================================================
app.post('/v1/chat/completions', async (req, res) => {
  const { model, messages, temperature, max_tokens, stream } = req.body;

  // ---------------------------------------------------------------
  // [A] Gemini 처리 구간 (수정됨: 400 에러 원인 제거)
  // ---------------------------------------------------------------
  if (model && model.toLowerCase().includes('gemini')) {
    if (!GEMINI_API_KEY) {
        console.error("Gemini API Key missing");
        return res.status(500).json({ error: "Gemini API Key is missing in server env." });
    }

    try {
      console.log(`🔹 Gemini Request: ${model}`);
      
      // Janitor 요청 복사
      const newBody = { ...req.body };
      
      // [문제 해결] 구글 API가 싫어하는 옵션들 제거
      if (newBody.repetition_penalty) delete newBody.repetition_penalty;
      
      // 🚨 [핵심 수정] 아래 safetySettings가 400 에러의 주범이었습니다.
      // OpenAI 호환 모드에서는 이 설정을 보내면 에러가 납니다. 주석 처리합니다.
      /*
      newBody.safetySettings = [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ];
      */

      // 구글로 전송
      const response = await axios.post(GEMINI_URL, newBody, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GEMINI_API_KEY}`
        },
        responseType: 'stream', 
        maxBodyLength: Infinity
      });

      // 스트리밍 헤더 설정
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      return response.data.pipe(res);

    } catch (error) {
      console.error("Gemini Error:", error.message);
      
      // 에러 내용을 더 자세히 로그에 남김 (디버깅용)
      if (error.response) {
          console.error("Gemini Error Data:", JSON.stringify(error.response.data));
          return res.status(error.response.status).json(error.response.data);
      }
      return res.status(500).json({ error: "Gemini Upstream Error" });
    }
  }

  // ---------------------------------------------------------------
  // [B] NVIDIA 처리 구간 (작가님의 '잘 되던 원본 코드' 100% 복구)
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

    // 🔴 [핵심 수정] Axios 전송 (원본 유지)
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json',
      maxBodyLength: Infinity, 
      maxContentLength: Infinity 
    });

    // ⭐ [이게 빠져서 무한로딩 걸렸던 것임! 원본 그대로 복구]
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
