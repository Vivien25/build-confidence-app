BetterMe: AI-Powered Confidence Coach 🚀
BetterMe is a full-stack AI coaching platform designed to help users build self-confidence through adaptive micro-plans. By leveraging the Google Gemini API, it provides a multi-modal experience (text and voice) to help users navigate challenges in work, social life, and personal growth.

✨ Key Features
1. Adaptive AI Coaching: Uses Gemini (Pro/Flash) to detect user confidence levels and adjust the difficulty of growth plans.
2. Multi-Modal Interaction: Support for both text-based chat and voice recording/playback.
3. Visual Roadmap: Automatically generates interactive flowcharts using Mermaid.js based on AI-suggested steps.
4. Persona-Based Guidance: Choice of two distinct coaches: Mira (Compassionate) and Kai (Empowerment).
5. Progress Tracking: Integrated confidence score history and growth analytics.
6. Session Persistence: Hybrid storage using SQLite for user profiles and JSON/Local Storage for high-frequency state management.

🛠️ Tech Stack
1. Frontend
   Framework: React 18 (Vite)
   Routing: React Router
   Visualization: Mermaid.js & Lucide Icons
   Audio: Web Speech API & MediaRecorder
2. Backend
   API Framework: FastAPI (Python)
   ORM/Database: SQLAlchemy with SQLite
   AI SDK: Google Generative AI (Gemini)
   Environment: Python Dotenv for configuration

🚀 Getting Started
1. Prerequisites
   Node.js (v18+)
   Python 3.10+
   Google Gemini API Key
2. Backend Setup
   Navigate to the /backend directory.

   Install dependencies:
       pip install -r requirements.txt
       Create a .env file and add your API key:
       GOOGLE_API_KEY=your_gemini_api_key_here

   Start the server:
       uvicorn main:app --reload

3. Frontend Setup
   Navigate to the /frontend directory.

   Install dependencies:
       npm install
   Start the development server:
       npm run dev

📂 Project Structure
1. backend/chat.py: Core AI logic, prompt engineering, and confidence detection.
2. backend/models.py: Database schema for user management.
3. frontend/src/pages/Chat.jsx: Main interface featuring Mermaid rendering and audio handling.
4. frontend/src/pages/IntroVideo.jsx: Video-based coach introduction and onboarding.
