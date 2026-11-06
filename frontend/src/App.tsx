import { Route, Routes } from "react-router-dom";
import { ProtectedRoute } from "./auth/ProtectedRoute";
import AuthForm from "./pages/AuthForm";
import TodoPage from "./pages/TodoPage";

// The router (BrowserRouter) and AuthProvider are added in main.tsx. Tests add their own.
export default function App() {
  return (
    <Routes>
      <Route path="/signin" element={<AuthForm mode="signin" />} />
      <Route path="/signup" element={<AuthForm mode="signup" />} />
      <Route element={<ProtectedRoute />}>
        <Route path="/" element={<TodoPage />} />
      </Route>
      <Route path="*" element={<p>Page not found.</p>} />
    </Routes>
  );
}
