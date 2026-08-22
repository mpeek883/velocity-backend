const fetch = require('node-fetch');
const cheerio = require('cheerio');

/**
 * VelocityCRM Free Sources Candidate Scraper
 * Scrapes from 4 free job boards to find candidates
 */

class FreeSourcesScraper {
  constructor() {
    this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    this.timeout = 10000;
  }

  /**
   * Main search method - orchestrates scraping from all sources
   */
  async searchCandidates(query, sources = ['jobvertise', 'craigslist', 'wellfound', 'postjobfree']) {
    console.log(`🔍 Searching for "${query}" across ${sources.length} sources...`);
    
    const results = {};
    const promises = [];

    if (sources.includes('jobvertise')) {
      promises.push(
        this.scrapeJobvertise(query)
          .then(data => { results.jobvertise = data; })
          .catch(err => { 
            console.error('❌ Jobvertise error:', err.message);
            results.jobvertise = [];
          })
      );
    }

    if (sources.includes('craigslist')) {
      promises.push(
        this.scrapeCraigslist(query)
          .then(data => { results.craigslist = data; })
          .catch(err => { 
            console.error('❌ Craigslist error:', err.message);
            results.craigslist = [];
          })
      );
    }

    if (sources.includes('wellfound')) {
      promises.push(
        this.scrapeWellfound(query)
          .then(data => { results.wellfound = data; })
          .catch(err => { 
            console.error('❌ Wellfound error:', err.message);
            results.wellfound = [];
          })
      );
    }

    if (sources.includes('postjobfree')) {
      promises.push(
        this.scrapePostJobFree(query)
          .then(data => { results.postjobfree = data; })
          .catch(err => { 
            console.error('❌ PostJobFree error:', err.message);
            results.postjobfree = [];
          })
      );
    }

    // Wait for all scrapes to complete
    await Promise.all(promises);

    const totalCandidates = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
    console.log(`✅ Scraping complete! Found ${totalCandidates} total candidates`);

    return {
      query,
      timestamp: new Date().toISOString(),
      sources: results,
      totalCandidates,
      breakdown: {
        jobvertise: results.jobvertise?.length || 0,
        craigslist: results.craigslist?.length || 0,
        wellfound: results.wellfound?.length || 0,
        postjobfree: results.postjobfree?.length || 0
      }
    };
  }

  /**
   * Scrape Jobvertise.com - Free job board
   */
  async scrapeJobvertise(query) {
    console.log(`  🔎 Scraping Jobvertise for "${query}"...`);
    const url = `https://www.jobvertise.com/jobs?q=${encodeURIComponent(query)}&p=1`;
    
    try {
      const response = await fetch(url, { 
        headers: { 'User-Agent': this.userAgent },
        timeout: this.timeout
      });
      const html = await response.text();
      const $ = cheerio.load(html);
      
      const candidates = [];
      $('.job-item, .job-card, [data-job-id]').slice(0, 15).each((i, el) => {
        const title = $(el).find('.job-title, .position, h2').text().trim();
        const company = $(el).find('.company, .employer, .job-company').text().trim();
        const location = $(el).find('.location, .job-location, .city').text().trim();
        const description = $(el).find('.job-desc, .description, p').text().trim().substring(0, 200);
        const link = $(el).find('a').attr('href') || '';
        
        if (title || company) {
          candidates.push({
            name: title || 'Job Listing',
            title: title || 'Position',
            company: company || 'Unknown',
            location: location || 'Not specified',
            description: description || '',
            source: 'Jobvertise',
            link: link.startsWith('http') ? link : `https://www.jobvertise.com${link}`,
            found_at: new Date().toISOString()
          });
        }
      });
      
      console.log(`    ✅ Found ${candidates.length} candidates on Jobvertise`);
      return candidates;
    } catch (err) {
      console.log(`    ⚠️ Jobvertise scrape failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Scrape Craigslist - Gigs and Jobs sections
   */
  async scrapeCraigslist(query) {
    console.log(`  🔎 Scraping Craigslist for "${query}"...`);
    
    // Try the SF Bay area as a default (can be made dynamic)
    const url = `https://sfbay.craigslist.org/search/ggg?query=${encodeURIComponent(query)}`;
    
    try {
      const response = await fetch(url, { 
        headers: { 'User-Agent': this.userAgent },
        timeout: this.timeout
      });
      const html = await response.text();
      const $ = cheerio.load(html);
      
      const candidates = [];
      $('.result-row').slice(0, 15).each((i, el) => {
        const title = $(el).find('.result-title').text().trim();
        const link = $(el).find('.result-title').attr('href') || '';
        const date = $(el).find('.result-date').text().trim();
        
        if (title) {
          candidates.push({
            name: title,
            title: title,
            company: 'Craigslist Gig',
            location: 'San Francisco Bay Area',
            description: `Posted on ${date}`,
            source: 'Craigslist',
            link: link.startsWith('http') ? link : `https://sfbay.craigslist.org${link}`,
            found_at: new Date().toISOString()
          });
        }
      });
      
      console.log(`    ✅ Found ${candidates.length} gigs on Craigslist`);
      return candidates;
    } catch (err) {
      console.log(`    ⚠️ Craigslist scrape failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Scrape Wellfound (formerly AngelList)
   */
  async scrapeWellfound(query) {
    console.log(`  🔎 Scraping Wellfound for "${query}"...`);
    const url = `https://wellfound.com/jobs?query=${encodeURIComponent(query)}`;
    
    try {
      const response = await fetch(url, { 
        headers: { 'User-Agent': this.userAgent },
        timeout: this.timeout
      });
      const html = await response.text();
      const $ = cheerio.load(html);
      
      const candidates = [];
      $('.job-card, [role="link"]').slice(0, 15).each((i, el) => {
        const title = $(el).find('.job-title, h2, .position').text().trim();
        const company = $(el).find('.company-name, .company, [data-company]').text().trim();
        const location = $(el).find('.location, .job-location').text().trim();
        const salary = $(el).find('.salary, .compensation').text().trim();
        
        if (title || company) {
          candidates.push({
            name: company || title || 'Startup',
            title: title || 'Position',
            company: company || 'Unknown',
            location: location || 'Remote',
            description: salary ? `Salary: ${salary}` : 'Wellfound startup opportunity',
            source: 'Wellfound',
            link: `https://wellfound.com/jobs?query=${encodeURIComponent(query)}`,
            found_at: new Date().toISOString()
          });
        }
      });
      
      console.log(`    ✅ Found ${candidates.length} opportunities on Wellfound`);
      return candidates;
    } catch (err) {
      console.log(`    ⚠️ Wellfound scrape failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Scrape PostJobFree - Completely free job board
   */
  async scrapePostJobFree(query) {
    console.log(`  🔎 Scraping PostJobFree for "${query}"...`);
    const url = `https://postjobfree.com/search?q=${encodeURIComponent(query)}`;
    
    try {
      const response = await fetch(url, { 
        headers: { 'User-Agent': this.userAgent },
        timeout: this.timeout
      });
      const html = await response.text();
      const $ = cheerio.load(html);
      
      const candidates = [];
      $('.listing, .job-posting, .result').slice(0, 15).each((i, el) => {
        const title = $(el).find('.title, h2, .job-title').text().trim();
        const company = $(el).find('.company, .employer').text().trim();
        const location = $(el).find('.location, .area').text().trim();
        const description = $(el).find('.description, p').text().trim().substring(0, 200);
        const link = $(el).find('a').attr('href') || '';
        
        if (title || company) {
          candidates.push({
            name: title || company || 'Job Listing',
            title: title || 'Position',
            company: company || 'Unknown',
            location: location || 'Not specified',
            description: description || 'Free job posting',
            source: 'PostJobFree',
            link: link.startsWith('http') ? link : `https://postjobfree.com${link}`,
            found_at: new Date().toISOString()
          });
        }
      });
      
      console.log(`    ✅ Found ${candidates.length} postings on PostJobFree`);
      return candidates;
    } catch (err) {
      console.log(`    ⚠️ PostJobFree scrape failed: ${err.message}`);
      return [];
    }
  }
}

module.exports = FreeSourcesScraper;
