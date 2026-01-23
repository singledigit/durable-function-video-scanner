export const useApi = () => {
  const config = useRuntimeConfig();
  const { getIdToken, user } = useAuth();

  const apiCall = async (path: string, options: RequestInit = {}) => {
    const token = await getIdToken();
    
    const response = await fetch(`${config.public.apiEndpoint}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token,
        ...options.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.statusText}`);
    }

    return response.json();
  };

  const uploadVideo = async (filename: string, contentType: string) => {
    return apiCall('/upload', {
      method: 'POST',
      body: JSON.stringify({ filename, contentType }),
    });
  };

  const listScans = async () => {
    return apiCall('/scans');
  };

  const getScan = async (scanId: string) => {
    return apiCall(`/scans/${scanId}`);
  };

  const listPending = async () => {
    return apiCall('/admin/pending');
  };

  const approveScan = async (scanId: string, approved: boolean, comments?: string) => {
    return apiCall('/approval', {
      method: 'POST',
      body: JSON.stringify({ 
        scanId, 
        approved, 
        reviewedBy: user.value?.username || 'admin',
        comments 
      }),
    });
  };

  return {
    uploadVideo,
    listScans,
    getScan,
    listPending,
    approveScan,
  };
};
