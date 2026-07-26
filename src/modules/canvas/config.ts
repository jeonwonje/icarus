export type CanvasConfig = {
  baseUrl: string;
  token: string;
};

let cached: CanvasConfig | undefined;

export function getCanvasConfig(): CanvasConfig {
  if (!cached) throw new Error('canvas config not initialized — module must register first');
  return cached;
}

export function canvasConfig(input: {
  selftest: boolean;
  baseUrl?: string;
  token?: string;
}): CanvasConfig {
  if (input.selftest) {
    cached = { baseUrl: 'https://selftest.instructure.com', token: 'selftest' };
    return cached;
  }
  const baseUrl = (input.baseUrl ?? process.env.CANVAS_BASE_URL ?? '').replace(/\/$/, '');
  const token = input.token ?? process.env.CANVAS_API_TOKEN ?? '';
  if (!baseUrl) throw new Error('CANVAS_BASE_URL is required');
  if (!token) throw new Error('CANVAS_API_TOKEN is required');
  cached = { baseUrl, token };
  return cached;
}
