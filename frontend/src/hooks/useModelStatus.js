// 模型固定配置（env 写死，见 01 §4）：chat / extract / embedding 三槽位恒已配置，
// 不再请求设置页 function-models 接口。返回结构保持不变，供聊天/关系网/桌面助手页消费
// （"未配置模型"引导 banner 因此不再出现）。
const FIXED_STATUS = {
  chat_model_id: '',
  extract_model_id: '',
  embedding_model_id: '',
  chat_configured: true,
  extract_configured: true,
  embedding_configured: true,
  loaded: true,
};

export function useModelStatus() {
  const refresh = () => Promise.resolve(FIXED_STATUS);
  return { ...FIXED_STATUS, refresh };
}
