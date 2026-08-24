<h1 align="center">🚀 Angular Quiz App</h1>

<p>
<strong>A full-featured Angular learning and interview-preparation platform built with Angular 22, TypeScript, Signals, RxJS, Angular Material, and a Node/Express backend.</strong>
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
  <a href="https://marvinrusinek.github.io/angular-22-quiz-app">
    ▶ Launch Live Demo
  </a>
</p>

<hr>

<h2>📸 Screenshot</h2>

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
<li>Backend-driven Interview Mode with timed mixed-topic assessments, session persistence, answer submission, server-side scoring, and protected result retrieval</li>
<li>Topic Quiz system supporting single-answer, multiple-answer, immediate feedback, explanations, timers, shuffling, and detailed results</li>
<li>Performance analytics including interview history, performance trends, topic-level analysis, and Weak Areas Practice</li>
<li>Production-oriented security including strict CSP and backend boundaries that prevent interview answers from being exposed to the active client session</li>
<li>Comprehensive automated testing covering Angular unit tests and Playwright end-to-end workflows</li>
<li>PWA and responsive UI built with Angular Material and accessibility-conscious interaction patterns</li>
</ul>

<hr>

<h2>✨ Core Features</h2>

<p><strong>Topic Quizzes</strong> — Single- and multiple-answer questions, timers, shuffling, immediate feedback, explanations, and detailed review.</p>
<p><strong>Interview Mode</strong> — Configurable mixed-topic assessments with difficulty-based presets, timed sessions, deferred feedback, session persistence, and backend scoring.</p>
<p><strong>Interview Analytics</strong> — Results, history, performance trends, and topic-level performance.</p>
<p><strong>Weak Areas Practice</strong> — Analyzes previous quiz performance to identify weaker topics and generate targeted practice opportunities.</p>
<p><strong>Progress & Achievements</strong> — Progress tracking and achievements across the learning experience.</p>
<p><strong>Modern UX</strong> — Angular Material, responsive layouts, dark/light themes, keyboard navigation, accessibility-focused interactions, and PWA support.</p>
<p><strong>Testing & Reliability</strong> — Angular unit testing and Playwright end-to-end coverage, including backend session and database isolation.</p>

<hr>

<h2>🧭 Architecture Overview</h2>

<p>
The application follows a modular frontend/backend architecture. Angular container components orchestrate application flow, focused services encapsulate business logic, and reactive state keeps the UI synchronized with user interactions. Interview Mode communicates with a Node/Express REST API responsible for session persistence, answer submission, server-side scoring, and protected result retrieval.
</p>

<p>
It combines <strong>Angular Signals</strong> for fine-grained reactive UI state with <strong>RxJS</strong> for asynchronous data flows,
event coordination, and cross-component communication.
</p>

<h3>High-Level Flow</h3>

<pre><code>
                         Angular 22 Frontend
                                │
                 ┌──────────────┴──────────────┐
                 │                             │
            Topic Quizzes                 Interview Mode
                 │                             │
        Angular Services             Interview API Services
                 │                             │
          Signals + RxJS                    REST API
                 │                             │
           Reactive UI                 Node / Express
                                               │
                                  Interview Session Layer
                                               │
                                          PostgreSQL
</code></pre>

<hr>

<h2>🛠️ Technology Stack</h2>

<ul>
<li><strong>Frontend:</strong> Angular 22, TypeScript</li>
<li><strong>Reactive State:</strong> Angular Signals, RxJS</li>
<li><strong>UI:</strong> Angular Material, SCSS</li>
<li><strong>Forms:</strong> Reactive Forms, Signal Forms</li>
<li><strong>Backend:</strong> Node.js, Express</li>
<li><strong>Database:</strong> PostgreSQL</li>
<li><strong>Testing:</strong> Unit Testing, Playwright End-to-End Testing</li>
<li><strong>Platform:</strong> Progressive Web App (PWA)</li>
</ul>

<hr>

<h2>📁 Project Structure</h2>
<p>The project is organized into reusable UI components, feature containers, and focused service layers to promote separation of concerns, maintainability, and scalability.</p>
<pre><code>
angular-22-quiz-app/
├── src/
│   └── app/
│       ├── components/
│       ├── containers/
│       ├── interview/
│       ├── practice/
│       └── shared/
│           ├── services/
│           ├── models/
│           └── utils/
│
├── backend/
│   ├── routes/
│   ├── services/
│   ├── data/
│   └── database/
│
├── e2e/
└── ...
</code></pre>

<hr>

<h2>⚙️ Getting Started</h2>

<h3>Prerequisites</h3>

<ul>
<li>Node.js 22 or later</li>
<li>Angular CLI 22</li>
<li>PostgreSQL</li>
</ul>

<h3>Installation</h3>

<pre><code>git clone https://github.com/marvinrusinek/angular-22-quiz-app.git
cd angular-22-quiz-app
npm install</code></pre>

<!--
<h3>PostgreSQL Setup</h3>

<h3>Environment Configuration</h3>

<h3>Run the Backend API</h3>
-->

<h3>Run the Angular Frontend</h3>

<pre><code>ng serve</code></pre>

<p>Open your browser and navigate to:</p>

<pre><code>http://localhost:4200</code></pre>

<p>The application will automatically reload when source files are modified.</p>

<hr>

<h2>🗺️ Roadmap</h2>

<ul>
<li>Expand quiz review with advanced filtering and sorting</li>
<li>Continue adopting modern Angular reactive patterns and APIs</li>
<li>Further simplify complex feature areas through architectural refactoring</li>
<li>Continue improving accessibility, responsive design, and touch interactions</li>
</ul>

<hr>

<h2>⭐ Support</h2>

<p>If you enjoyed exploring this project or found it helpful, please consider giving it a ⭐ on GitHub. Your support helps drive continued improvements, new features, and ongoing maintenance.</p>
<p>The project continues to evolve with new Angular topics, assessment capabilities, and architectural improvements.</p>

<hr>

<h2>📄 License</h2>

<p> Distributed under the <strong>MIT License</strong>. See the <a href="./LICENSE">LICENSE</a> file for more information. </p>
