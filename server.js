// server.js
require('dotenv').config();
const express    = require('express');
const bodyParser = require('body-parser');
const cors       = require('cors');
const puppeteer  = require('puppeteer');

const app = express();
app.use(cors());
app.use(bodyParser.json());

async function autoScrollByCards(page, maxTime = 30000) {
  await page.evaluate(async (max) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const start = Date.now(), cardsSel = 'div.discussion-card.ng-scope';
    let prev = 0, stable = 0;
    while (Date.now() - start < max) {
      const cards = Array.from(document.querySelectorAll(cardsSel));
      if (cards.length) cards[cards.length - 1].scrollIntoView({ block: 'end' });
      await sleep(500);
      if (cards.length === prev) {
        if (++stable >= 3) break;
      } else {
        prev = cards.length; stable = 0;
      }
    }
  }, maxTime);
}

app.post('/scrape', async (req, res) => {
  const { username, password, code } = req.body;
  if (!username || !password || !code) {
    return res.status(400).json({ error: 'username, password & code required' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();

    // 1) LOGIN
    await page.goto('https://nlp.nexterp.in/nlp/nlp/login', { waitUntil: 'networkidle2' });
    await page.type('input[name="username"]', username);
    await page.type('input[name="password"]', password);
    await page.type('input[name="code"]', code);
    await Promise.all([
      page.click('button[name="btnSignIn"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
    ]);
    if (!page.url().includes('student-dashboard')) {
      throw new Error('Login failed');
    }

    // 2) NAVIGATE + SCROLL
    const feedUrl = 'https://nlp.nexterp.in/nlp/nlp/v1/workspace/studentlms?urlgroup=Student%20Workspace#/dashboard/discussion';
    await page.goto(feedUrl, { waitUntil: 'networkidle2' });
    await page.waitForSelector('div.discussion-card.ng-scope', { timeout: 15000 });
    await autoScrollByCards(page, 30000);

    // 3) EXTRACT POSTS
    const posts = await page.$$eval('div.discussion-card.ng-scope', cards => {
      return cards.map(card => {
        const title = card.querySelector('md-card.postLink p.postTitle')?.innerText.trim().toLowerCase();
        if (title === 'resource') return null;

        let teacher = '', datetime = '';
        const hdr = card.querySelector('div.descTitleContent.layout-align-center-start');
        if (hdr) {
          teacher  = hdr.querySelector('h3')?.innerText.trim() || '';
          datetime = hdr.querySelector('span.direction-normal')?.innerText.trim() || '';
        }
        if (!teacher && !datetime) {
          const items = Array.from(card.querySelectorAll('ul.feed-details li')).map(e=>e.innerText.trim());
          teacher  = items[0]?.replace(/^By\s*/i,'') || '';
          datetime = items[1] || '';
        }

        let content = '';
        const foot = card.querySelector('div.disc-footer h3');
        if (foot) content = foot.innerHTML.trim();
        else content = card.querySelector('div.descTitleContent p')?.innerText.trim() || '';

        const atEls = Array.from(card.querySelectorAll('div.post-details-card.cursor'));
        const attachments = atEls.map(el => {
          if (el.querySelector('video source'))  return el.querySelector('source').src;
          if (el.querySelector('embed'))         return el.querySelector('embed').src;
          if (el.querySelector('img'))           return el.querySelector('img').src;
          if (el.querySelector('audio'))         return el.querySelector('audio').src;
          return null;
        }).filter(u => u);

        return { teacher, datetime, content, attachments };
      }).filter(x => x);
    });

    await browser.close();
    return res.json({ posts });
  } catch (err) {
    if (browser) await browser.close();
    return res.status(500).json({ error: err.message });
  }
});

// Start server on port 3000 (Render sets its own PORT env var)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API up on port ${PORT}`));

