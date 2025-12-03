const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
// Google Cloud Run의 기본 포트(8080)를 우선 사용
const PORT = process.env.PORT || 3000;

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

const SHOW_REASONING = false;
const ENABLE_THINKING_MODE = false;

// 🔴 [필수] 용량 제한 설정은 반드시 코드 최상단(app 선언 직후)에 와야 함!
// 50mb로 대폭 상향 (텍스트/채팅로그 충분)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());

// 모델 매핑
const MODEL_MAPPING = {
  'gpt-4o': 'meta/llama-3.1-405b-instruct',
  'gpt-4': 'meta/llama-3.1-405b-instruct',
  'gpt-4-turbo': 'deepseek-ai/deepseek-r1', // R1 사용 가능 (Cloud Run 환경)
  'gpt-3.5-turbo': 'meta/llama-3.1-70b-instruct',
  'claude-3-opus': 'meta/llama-3.1-405b-instruct',
  'gemini-pro': 'deepseek-ai/deepseek-r1'
};

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI to NVIDIA NIM Proxy',
    port: PORT
  });
});

app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy'
  }));
  res.json({ object: 'list', data: models });
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
    let nimModel = MODEL_MAPPING[model] || 'meta/llama-3.1-405b-instruct';

    // 요청 구성
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 1024,
      extra_body: ENABLE_THINKING_MODE ? { chat_template_kwargs: { thinking: true } } : undefined,
      stream: stream || false
    };

    // 🔴 [핵심 수정] Axios 전송 시에도 용량 제한 해제 (maxBodyLength: Infinity)
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json',
      maxBodyLength: Infinity, // 전송 용량 무제한
      maxContentLength: Infinity // 수신 용량 무제한
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
    console.error('Proxy error:', error.message);
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
