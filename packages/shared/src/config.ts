const getEnvValue = (keys: string[]) => {
  if (typeof process !== 'undefined') {
    const env = (process as any).env || {};
    for (const key of keys) {
      if (env[key]) return env[key] as string;
    }
  }

  const metaEnv = (import.meta as any).env || {};
  for (const key of keys) {
    if (metaEnv[key]) return metaEnv[key] as string;
  }

  return '';
};

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
  if (!url) url = 'https://34.158.217.115';

  return url;
};

export const setServerUrl = (url: string) => {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem('wr_server_url', url);
  }
};

const parseEnvUrls = (value: string) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

export const getIceServers = (): RTCIceServer[] => {
  const iceServers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ];

  const turnUrl = getEnvValue(['VITE_WONREMOTE_TURN_URL', 'WONREMOTE_TURN_URL']);
  const turnUsername = getEnvValue(['VITE_WONREMOTE_TURN_USERNAME', 'WONREMOTE_TURN_USERNAME']);
  const turnCredential = getEnvValue(['VITE_WONREMOTE_TURN_CREDENTIAL', 'WONREMOTE_TURN_CREDENTIAL']);

  const turnUrls = turnUrl ? parseEnvUrls(turnUrl) : [];
  if (turnUrls.length) {
    const turnServer: RTCIceServer = { urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls };
    if (turnUsername) turnServer.username = turnUsername;
    if (turnCredential) turnServer.credential = turnCredential;
    iceServers.push(turnServer);
  }

  return iceServers;
};
