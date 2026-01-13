import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Welcome from "./pages/Welcome";
import Intro from "./pages/IntroVideo";
import Onboarding from "./pages/Onboarding";
import Focus from "./pages/Focus";
import Chat from "./pages/Chat";
import Plans from "./pages/Plans";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Welcome />} />
        <Route path="/intro" element={<Intro />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/focus" element={<Focus />} />
        <Route path="/chat" element={<Chat />} />
        <Route path="/plans" element={<Plans />} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
