export type DownloadInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export async function saveDesktopFile(file: { filename: string; blob: Blob }, invoke: DownloadInvoke, signal?: AbortSignal): Promise<string> {
  let id: string | undefined;
  const check = () => { if (signal?.aborted) throw new Error("저장이 취소됐습니다."); };
  try {
    check();
    id = await invoke<string>("begin_viewer_download", { filename: file.filename, total: file.blob.size });
    for (let offset = 0; offset < file.blob.size; offset += 65536) {
      check();
      const bytes = new Uint8Array(await file.blob.slice(offset, offset + 65536).arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      await invoke("write_viewer_download", { id, offset, data: btoa(binary) });
    }
    check();
    return await invoke<string>("finish_viewer_download", { id });
  } catch (error) {
    if (id) await invoke("abort_viewer_download", { id }).catch(() => undefined);
    throw error;
  }
}
