<h1 align="center">🚀 Angular Quiz App</h1>

<p>
<strong>A full-featured Angular learning and interview-preparation platform built with Angular 22, TypeScript, Signals, RxJS, and Angular Material, with Node/Express powering Topic Quizzes and Spring Boot powering Interview Mode.</strong>
</p>

<p>
The application combines topic-based Angular quizzes with a timed Interview Mode, performance analytics, weak-area practice, progress tracking, and detailed answer review. It demonstrates modern Angular architecture, reactive state management, backend-driven assessment sessions, automated testing, accessibility, and maintainable full-stack application design.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Angular-22-red" alt="Angular 22">
  <img src="https://img.shields.io/badge/TypeScript-Enabled-blue" alt="TypeScript">
  <img src="https://img.shields.io/badge/RxJS-Reactive-purple" alt="RxJS">
  <img src="https://img.shields.io/badge/Signals-Integrated-orange" alt="Angular Signals">
  <img src="https://img.shields.io/badge/Status-Active%20Development-brightgreen" alt="Active Development">
</p>

<p align="center">
  <a href="https://marvinrusinek.github.io/angular-22-quiz-app">▶ Live Demo</a>
  ·
  <a href="#-screenshots">📸 Screenshots</a>
  ·
  <a href="#-architecture-overview">🧭 Architecture</a>
</p>

<hr>

<h2>📸 Screenshots</h2>

<p align="center">
<img src="screenshots/ss01.jpg" alt="Dependency Injection Quiz — Question 1 of 6" width="420">
</p>

<hr>

<h2>🎯 Goal / Purpose</h2>

<p>The goal of this project is to provide an interactive environment for learning, practicing, and assessing modern Angular knowledge while serving as a real-world demonstration of production-oriented Angular engineering.</p>

<p>Beyond traditional topic quizzes, the application includes a timed Interview Mode, performance analytics, weak-area practice, progress tracking, and detailed review workflows designed to support both learning and technical interview preparation.</p>

<p>The project also serves as an evolving engineering platform for applying modern Angular patterns, improving application architecture, strengthening testing and accessibility, and exploring secure frontend/backend boundaries.</p>

<hr>

<h2>🏆 Engineering Highlights</h2>

<ul>
<li>Angular 22 architecture using standalone components, Signals, RxJS, Signal Forms, and focused service layers</li>
<li>Spring Boot-powered Interview Mode with timed mixed-topic assessments, session persistence, answer submission, server-side scoring, and protected result retrieval</li>
<li>Topic Quiz system supporting single-answer, multiple-answer, immediate feedback, explanations, timers, shuffling, and detailed results</li>
<li>Performance analytics including interview history, performance trends, topic-level analysis, and Weak Areas Practice</li>
<li>Backend-authoritative quiz architecture with PostgreSQL as the source of truth, server-side correctness evaluation, protected assessment data, strict CSP, and no answer-bearing quiz bank shipped with the Angular application</li>
<li>Automated testing across the stack with Angular unit tests, Jest, Playwright, JUnit 5, MockMvc, Testcontainers, and Node/Spring API contract-parity testing</li>
<li>PWA and responsive UI built with Angular Material and accessibility-conscious interaction patterns</li>
<li>Dual-backend architecture with Node/Express and Spring Boot implementations sharing API contracts verified through cross-runtime parity testing</li>
</ul>

<hr>

<h2>✨ Core Features</h2>

<p><strong>Topic Quizzes</strong> — Single- and multiple-answer questions, code-snippet questions, timers, shuffling, immediate feedback, explanations, and detailed review.</p>
<p><strong>Interview Mode</strong> — Configurable mixed-topic assessments with difficulty-based presets, timed sessions, deferred feedback, session persistence, and backend scoring.</p>
<p><strong>Interview Analytics</strong> — Results, history, performance trends, and topic-level performance.</p>
<p><strong>Weak Areas Practice</strong> — Analyzes previous quiz performance to identify weaker topics and generate targeted practice opportunities.</p>
<p><strong>Progress & Achievements</strong> — Progress tracking and achievements across the learning experience.</p>
<p><strong>Modern UX</strong> — Angular Material, responsive layouts, dark/light themes, keyboard navigation, accessibility-focused interactions, and PWA support.</p>
<p><strong>Testing & Reliability</strong> — Angular unit testing and Playwright end-to-end coverage, including backend session and database isolation.</p>

<hr>

<h2>🧭 Architecture Overview</h2>

<p>The application follows a modular frontend/backend architecture. Angular container components orchestrate application flow, focused services encapsulate business logic, and Signals and RxJS keep the UI synchronized with user interactions. Topic Quizzes and quiz metadata are served through a Node/Express REST API, while Interview Mode session workflows are served through a Spring Boot REST API. Both backends use a shared PostgreSQL database, hosted on Neon in production, as the authoritative store for quiz content, assessment sessions, submitted answers, and server-side results.</p>

<p>The frontend combines <strong>Angular Signals</strong> for fine-grained reactive UI state with <strong>RxJS</strong> for asynchronous data flows, event coordination, and cross-component communication. Correctness-sensitive operations remain backend-authoritative so answer-bearing quiz data is not shipped with the Angular application. </p>

<h3>High-Level Flow</h3>

<pre><code>
                    Angular 22 Frontend
                           │
               ┌───────────┴───────────┐
               │                       │
         Topic Quizzes            Interview Mode
               │                       │
        Node / Express             Spring Boot
               │                  Spring JDBC
               │                 Spring Data JPA*
               │                       │
               └───────────┬───────────┘
                           │
                    PostgreSQL / Neon

* Spring Data JPA is used for quiz metadata;
  Interview persistence primarily uses Spring JDBC.
</code></pre>

<hr>

<h2>🛠️ Technology Stack</h2>

<ul>
  <li><strong>Frontend:</strong> Angular 22, TypeScript</li>
  <li><strong>Reactive State:</strong> Angular Signals, RxJS</li>
  <li><strong>UI:</strong> Angular Material, SCSS</li>
  <li><strong>Forms:</strong> Reactive Forms, Signal Forms</li>
  <li><strong>Topic Quiz API:</strong> Node.js 22, Express, TypeScript</li>
  <li><strong>Interview API:</strong> Java 21, Spring Boot, Spring JDBC, Spring Data JPA</li>
  <li><strong>Database:</strong> PostgreSQL — Neon-hosted in production</li>
  <li><strong>Security:</strong> Backend-authoritative correctness, strict CSP, CORS allow-list, rate limiting, HMAC-signed attempt receipts</li>
  <li><strong>Testing:</strong> Jest, Playwright, JUnit 5, MockMvc, Testcontainers, API contract-parity testing</li>
  <li><strong>Platform:</strong> Progressive Web App (PWA)</li>
  <li><strong>Hosting:</strong> GitHub Pages, Render, Oracle Cloud Infrastructure, Neon</li>
</ul>  

<hr>

<h2>📁 Project Structure</h2>
<p>The project is organized into an Angular frontend, dedicated Node/Express and Spring Boot APIs, automated end-to-end testing, and deployment infrastructure, with focused service layers and clear separation between application domains.</p>
<pre><code>
angular-22-quiz-app/
├── src/
│   └── app/
│       ├── components/
│       ├── containers/
│       └── shared/
│           ├── services/
│           ├── models/
│           └── utils/
│
├── backend/                         # Node/Express API
│   └── src/
│       ├── routes/
│       ├── quiz/
│       ├── interview/
│       └── database/
│
├── backend-spring/                  # Spring Boot API
│   └── src/
│       ├── main/
│       │   └── java/
│       └── test/
│
├── e2e/                             # Playwright end-to-end tests
│
├── deploy/
│   └── oracle/                      # Oracle Cloud deployment
│
├── docs/
├── scripts/
└── ...
</code></pre>

<hr>
<h2>⚙️ Getting Started</h2>

<h3>Prerequisites</h3>

<ul>
  <li>Node.js 22 or later</li>
  <li>Angular CLI 22</li>
  <li>Java 21</li>
  <li>PostgreSQL</li>
</ul>

<p>The project uses two backend services: a Node/Express API for Topic Quizzes and a Spring Boot API for Interview Mode. Both services connect to PostgreSQL.</p>

<h3>Installation</h3>

<pre><code>git clone https://github.com/marvinrusinek/angular-22-quiz-app.git
cd angular-22-quiz-app
npm install</code></pre>

<h3>Database Configuration</h3>

<p>PostgreSQL is the authoritative server-side data store for quiz content, Interview sessions, submitted answers, and results. Production uses PostgreSQL hosted by Neon.</p>

<p>Configure the required database connection and application environment variables before starting the backend services. Keep credentials and secrets in local environment configuration and never commit them to source control.</p>

<h3>Run the Topic Quiz API</h3>

<p>The Node/Express backend serves Topic Quizzes and quiz metadata.</p>

<pre><code>npm run dev</code></pre>

<p>The development command starts the Node/Express API together with the Angular development server.</p>

<h3>Run the Interview API</h3>

<p>Interview Mode is served by the Spring Boot backend. The project includes the Maven Wrapper, so a separate global Maven installation is not required.</p>

<pre><code>cd backend-spring
./mvnw spring-boot:run</code></pre>

<p>On Windows PowerShell:</p>

<pre><code>cd backend-spring
.\mvnw.cmd spring-boot:run</code></pre>

<p>The Spring Boot API runs locally on port <code>8080</code> when using the default development configuration.</p>

<h3>Run the Angular Frontend</h3>

<p>If the frontend is not already running through the development command, start it separately with:</p>

<pre><code>ng serve</code></pre>

<p>Open your browser and navigate to:</p>

<pre><code>http://localhost:4200</code></pre>

<p>For the complete local application, ensure the Angular frontend, Node/Express Topic Quiz API, Spring Boot Interview API, and PostgreSQL database are all available.</p>

<hr>

<h2>🗺️ Roadmap</h2>
<ul>
  <li>Introduce automated question-quality validation for quiz content</li>
  <li>Expand Interview Mode reporting and performance analytics</li>
  <li>Continue adopting modern Angular APIs and reactive patterns where they provide measurable architectural or UX improvements</li>
  <li>Expand accessibility and mobile/responsive UX improvements</li>
</ul>

<hr>

<h2>⭐ Support</h2>

<p>If you enjoyed exploring this project or found it helpful, please consider giving it a ⭐ on GitHub. Your support helps drive continued improvements, new features, and ongoing maintenance.</p>
<p>The project continues to evolve with new Angular topics, assessment capabilities, and architectural improvements.</p>

<hr>

<h2>📄 License</h2>

<p>Distributed under the <strong>MIT License</strong>. See the <a href="./LICENSE">LICENSE</a> file for more information. </p>
