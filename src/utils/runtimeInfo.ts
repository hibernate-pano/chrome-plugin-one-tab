export const getRuntimeManifest = () => {
  try {
    return chrome.runtime.getManifest();
  } catch {
    return null;
  }
};

export const getRuntimeVersion = () => {
  return getRuntimeManifest()?.version ?? '0.0.0';
};

export const getAppVersionLabel = () => {
  return `v${getRuntimeVersion()}`;
};
