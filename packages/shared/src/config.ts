const getEnvServerUrl = () => {
  // 1) Electron/Node runtime env
  if (typeof process !== 'undefined' && (process as any).env?.WONREMOTE_SERVER_URL) {
    return (process as any).env.WONREMOTE_SERVER_URL as string;
  }

  // 2) Vite env
  const metaEnv = (import.meta as any).env;
  return metaEnv?.VITE_WONREMOTE_SERVER_URL || metaEnv?.WONREMOTE_SERVER_URL || metaEnv?.VITE_SERVER_URL;
};

export const getServerUrl = () => {
  let url = '';

  // 1) LocalStorage override
  if (typeof window !== 'undefined') {
    const stored = window.localStorage.getItem('wr_server_url');
    if (stored) url = stored;
  }

  // 2) Env
  if (!url) url = getEnvServerUrl();

  // 3) Fallback (운영 서버 기본값)
  // - 개발/빌드 전 실행에서도 기본 서버가 GCP로 잡히도록 함
  if (!url) url = 'http://34.158.217.115';

  return url;
};

export const setServerUrl = (url: string) => {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem('wr_server_url', url);
  }
};
