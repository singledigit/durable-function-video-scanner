import { CognitoUserPool, CognitoUser, AuthenticationDetails, CognitoUserAttribute } from 'amazon-cognito-identity-js';

export const useAuth = () => {
  const config = useRuntimeConfig();
  const user = useState<any>('user', () => null);
  const isAuthenticated = computed(() => !!user.value);
  const isAdmin = computed(() => user.value?.groups?.includes('Admins'));

  const userPool = new CognitoUserPool({
    UserPoolId: config.public.userPoolId,
    ClientId: config.public.userPoolClientId,
  });

  const login = async (email: string, password: string) => {
    return new Promise((resolve, reject) => {
      const authDetails = new AuthenticationDetails({
        Username: email,
        Password: password,
      });

      const cognitoUser = new CognitoUser({
        Username: email,
        Pool: userPool,
      });

      cognitoUser.authenticateUser(authDetails, {
        onSuccess: async (result) => {
          const groups = result.getIdToken().payload['cognito:groups'] || [];
          user.value = {
            username: email,
            groups,
          };
          
          // Connect to WebSocket for realtime updates
          if (process.client) {
            const { connect } = useRealtimeUpdates();
            await connect();
          }
          
          resolve(result);
        },
        onFailure: (err) => {
          reject(err);
        },
      });
    });
  };

  const register = async (email: string, password: string) => {
    return new Promise((resolve, reject) => {
      const attributeList = [
        new CognitoUserAttribute({ Name: 'email', Value: email }),
      ];

      userPool.signUp(email, password, attributeList, [], (err, result) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(result);
      });
    });
  };

  const confirm = async (email: string, code: string) => {
    return new Promise((resolve, reject) => {
      const cognitoUser = new CognitoUser({
        Username: email,
        Pool: userPool,
      });

      cognitoUser.confirmRegistration(code, true, (err, result) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(result);
      });
    });
  };

  const logout = async () => {
    const cognitoUser = userPool.getCurrentUser();
    if (cognitoUser) {
      cognitoUser.signOut();
    }
    
    // Disconnect WebSocket
    if (process.client) {
      const { disconnect } = useRealtimeUpdates();
      disconnect();
    }
    
    user.value = null;
  };

  const loadUser = async () => {
    const cognitoUser = userPool.getCurrentUser();
    if (!cognitoUser) {
      user.value = null;
      return;
    }

    return new Promise((resolve) => {
      cognitoUser.getSession((err: any, session: any) => {
        if (err || !session.isValid()) {
          user.value = null;
          resolve(null);
          return;
        }

        const groups = session.getIdToken().payload['cognito:groups'] || [];
        user.value = {
          username: cognitoUser.getUsername(),
          groups,
        };
        
        // Reconnect WebSocket if user session exists
        if (process.client) {
          const { connect } = useRealtimeUpdates();
          connect();
        }
        
        resolve(user.value);
      });
    });
  };

  const getIdToken = async (): Promise<string> => {
    const cognitoUser = userPool.getCurrentUser();
    if (!cognitoUser) return '';

    return new Promise((resolve, reject) => {
      cognitoUser.getSession((err: any, session: any) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(session.getIdToken().getJwtToken());
      });
    });
  };

  return {
    user,
    isAuthenticated,
    isAdmin,
    login,
    register,
    confirm,
    logout,
    loadUser,
    getIdToken,
  };
};
