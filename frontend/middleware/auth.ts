export default defineNuxtRouteMiddleware(async (to, from) => {
  if (process.server) return;

  const { isAuthenticated, loadUser } = useAuth();
  
  await loadUser();

  if (!isAuthenticated.value) {
    return navigateTo('/');
  }
});
