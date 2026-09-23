import { Link } from 'react-router-dom'
import { BRAND } from '../lib/brand'
import { toolsByCategory } from '../data/tools'
import { useSeo } from '../hooks/useSeo'

export default function Tools() {
  useSeo({
    title: `Tools — ${BRAND}`,
    description:
      'The AI tools we actually recommend, organized by the job you need done. Vendor pricing changes often — check each site before buying.',
  })

  const groups = toolsByCategory()

  return (
    <>
      <section className="page-hero">
        <div className="container">
          <div className="page-eyebrow reveal">Tools</div>
          <h1 className="reveal d1">The tools we actually recommend.</h1>
          <p className="page-sub reveal d2">
            Organized by the job you need done. Pricing changes often — check each vendor's site
            before buying.
          </p>
        </div>
      </section>

      <section>
        <div className="container">
          <div className="tools-list">
            {groups.map((g, gi) => (
              <div className={`tools-group reveal d${(gi % 4) + 1}`} key={g.category}>
                <div className="tools-group-title">{g.category}</div>
                <div className="tools-group-grid">
                  {g.tools.map(t => (
                    <a
                      key={t.name}
                      href={t.url}
                      className="tool-card"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <div className="tool-name">{t.name}</div>
                      <div className="tool-job">{t.job}</div>
                      <div className="tool-arrow" aria-hidden="true">↗</div>
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="container">
          <div className="tools-bottom-grid reveal">
            <Link to="/course" className="tools-bottom-card">
              <div className="eyebrow">Tools you run yourself</div>
              <h3>The course →</h3>
              <p>Four weeks, live, small cohort. Learn to use these tools in your business.</p>
            </Link>
            <Link to="/audit" className="tools-bottom-card featured">
              <div className="eyebrow">AI we build and run for you</div>
              <h3>Get an AI Audit →</h3>
              <p>Fixed-price audit — top 3–5 AI opportunities in your business, with estimated hours and dollars saved.</p>
            </Link>
          </div>
        </div>
      </section>
    </>
  )
}
