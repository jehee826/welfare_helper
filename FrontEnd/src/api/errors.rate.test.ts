import { ApiError, chatError } from './errors';

it('요청 빈도 제한과 실행 중 혼잡을 구별한다', () => {
  expect(chatError(new ApiError('', 429, 'chat_rate_limited'))).toContain('질문 요청이 많습니다');
  expect(chatError(new ApiError('', 429, 'inference_busy'))).toContain('다른 요청을 처리 중');
});
