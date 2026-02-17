<script lang="ts">
  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
</script>

<footer class="site-footer">
  <div class="footer-content">
    <button onclick={scrollToTop} class="back-to-top-button">↑ Back to Top</button>
    <div class="footer-copyright">
      <a href="https://gitcitadel.com" class="copyright-link" target="_blank" rel="noopener noreferrer">
        GitCitadel LLC
      </a> ©2026 All rights reserved.
    </div>
  </div>
</footer>

<style>
  .site-footer {
    margin-top: 4rem;
    padding: 2rem 0;
    border-top: 1px solid var(--border-color);
    background: var(--bg-primary);
  }

  .footer-content {
    max-width: 1200px;
    margin: 0 auto;
    padding: 0 2rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 1rem;
    box-sizing: border-box;
    width: 100%;
  }

  .back-to-top-button {
    background: var(--button-primary);
    color: white;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    cursor: pointer;
    font-size: 0.875rem;
    font-family: 'IBM Plex Serif', serif;
    transition: background 0.2s ease, transform 0.2s ease;
  }

  .back-to-top-button:hover {
    background: var(--button-primary-hover);
    transform: translateY(-2px);
  }

  .back-to-top-button:active {
    transform: translateY(0);
  }

  .footer-copyright {
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  .copyright-link {
    color: var(--link-color);
    text-decoration: none;
    transition: color 0.2s ease;
  }

  .copyright-link:hover {
    color: var(--link-hover);
    text-decoration: underline;
  }

  @media (max-width: 768px) {
    .site-footer {
      padding: 1.5rem 0;
      margin-top: 2rem;
    }

    .footer-content {
      flex-direction: column;
      text-align: center;
      padding: 0 1rem;
      gap: 1rem;
    }

    .back-to-top-button {
      width: 100%;
      max-width: 200px;
    }
  }

  @media (max-width: 480px) {
    .footer-content {
      padding: 0 0.75rem;
    }

    .footer-copyright {
      font-size: 0.75rem;
    }
  }
</style>
