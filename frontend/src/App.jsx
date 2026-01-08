import { BrowserRouter, Routes, Route } from "react-router-dom";
import Welcome from "./pages/Welcome";
import Onboarding from "./pages/Onboarding";
import Chat from "./pages/Chat";
import Work from "./pages/Work"; // create this page if you don't have it yet

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Welcome />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/work" element={<Work />} />
      </Routes>
    </BrowserRouter>
  );
}
