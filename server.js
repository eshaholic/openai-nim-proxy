const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
// Google Cloud Run의 기본 포트(8080)를 우선 사용하도록 수정
const PORT = process.env.PORT || 3000;

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

const SHOW_REASONING = false;
const ENABLE_THINKING_MODE = false;

// 🔴 [핵심 수정] 모델 매핑 테이블 (골라 쓰기 가능)
const MODEL_MAPPING = {
  // 1. 메인 추천: Llama 3.1 405B (논리왕, 안정성 최고, 작가님 봇 최적화)
  // 제니터에서 'gpt-4o' 또는 'gpt-4'를 선택하면 이게 나옵니다.
  'gpt-4o': 'meta/llama-3.1-405b-instruct',
  'gpt-4': 'meta/llama-3.1-405b-instruct',

  // 2. 서브 추천: DeepSeek V3 (감성왕, 필력 좋음, 덜 건조함)
  // 제니터에서 'gpt-4-turbo'를 선택하면 이게 나옵니다.
  // *주의: R1이 아니라 V3라서 난수 안 터집니다.
  'gpt-4-turbo': 'deepseek-ai/deepseek-v3',

  // 3. 속도용: Llama 3.1 70B (가볍고 빠름)
  // 제니터에서 'gpt-3.5-turbo'를 선택하면 이게 나옵니다.
  'gpt-3.5-turbo': 'meta/llama-3.1-70b-instruct',

  // 4. 기타 호환성 (SillyTavern 등 다른 툴을 위해 남겨둠)
  'claude-3-opus': 'meta/llama-3.1-405b-instruct',
  'claude-3-sonnet': 'meta/llama-3.1-70b-instruct',
  'gemini-pro': 'deepseek-ai/deepseek-v3'
};

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI to NVIDIA NIM Proxy',
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE
  });
});

app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy'
  }));

  res.json({
    object: 'list',
    data: models
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;

    let nimModel = MODEL_MAPPING[model];
    
    // 매핑된 모델이 없으면 기본값으로 Llama 405B 사용 (안전장치)
    if (!nimModel) {
       nimModel = 'meta/llama-3.1-405b-instruct';
    }

    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 1024, // 기본 토큰 넉넉하게
      extra_body: ENABLE_THINKING_MODE ? { chat_template_kwargs: { thinking: true } } : undefined,
      stream: stream || false
    };

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json'
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      response.data.pipe(res); // 스트림 데이터를 그대로 전달 (복잡한 로직 제거하여 안정성 확보)
      
    } else {
      // Non-streaming 응답 처리
      res.json(response.data);
    }

  } catch (error) {
    console.error('Proxy error:', error.message);
    if (error.response) {
        console.error('Error details:', error.response.data);
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
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

// 0.0.0.0으로 바인딩하여 외부 접속 허용 (구글 클라우드 필수)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`OpenAI to NVIDIA NIM Proxy running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
