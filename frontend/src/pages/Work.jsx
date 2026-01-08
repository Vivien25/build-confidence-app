import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { getProfile } from "../utils/profile";
import Chat from "./Chat";

export default function Work() {
  const navigate = useNavigate();

  useEffect(() => {
    const profile = getProfile();
    if (!profile) navigate("/onboarding");
  }, [navigate]);

  return (
    <div style={{ padding: 16 }}>
      <Chat />
    </div>
  );
}
