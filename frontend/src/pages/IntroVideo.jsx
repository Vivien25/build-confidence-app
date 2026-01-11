import { useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import introVideo from "../assets/intro.mp4";

export default function IntroVideo() {
  const navigate = useNavigate();
  const videoRef = useRef(null);
  const [isMuted, setIsMuted] = useState(true);

  const goNext = () => {
    navigate("/onboarding");
  };

  // Go to onboarding when video ends
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleEnded = () => goNext();
    video.addEventListener("ended", handleEnded);

    return () => video.removeEventListener("ended", handleEnded);
  }, []);

  // Enable sound after user interaction
  const enableSound = async () => {
    const video = videoRef.current;
    if (!video) return;

    video.muted = false;
    setIsMuted(false);

    try {
      await video.play(); // required for iOS
    } catch (err) {
      console.log("Play blocked:", err);
    }
  };

  return (
    <div style={styles.container}>
      <video
        ref={videoRef}
        src={introVideo}
        autoPlay
        muted={isMuted}
        playsInline
        preload="auto"
        style={styles.video}
      />

      {/* Tap to enable sound */}
      {isMuted && (
        <button style={styles.soundBtn} onClick={enableSound}>
          🔊 Tap for sound
        </button>
      )}

      {/* Skip button */}
      <button style={styles.skipBtn} onClick={goNext}>
        Skip
      </button>
    </div>
  );
}

const styles = {
  container: {
    position: "fixed",
    inset: 0,
    overflow: "hidden",
    backgroundColor: "#000",
  },
  video: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "contain",     
    objectPosition: "center",
  },
  soundBtn: {
    position: "absolute",
    left: 20,
    bottom: 20,
    padding: "10px 14px",
    borderRadius: 10,
    border: "none",
    background: "rgba(0,0,0,0.6)",
    color: "#fff",
    fontSize: 14,
    cursor: "pointer",
    zIndex: 2,
  },
  skipBtn: {
    position: "absolute",
    right: 20,
    top: 20,
    padding: "10px 14px",
    borderRadius: 10,
    border: "none",
    background: "rgba(0,0,0,0.6)",
    color: "#fff",
    fontSize: 14,
    cursor: "pointer",
    zIndex: 2,
  },
};
