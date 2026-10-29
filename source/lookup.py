"""Free, key-less look-ups: find an open-access PDF for a DOI / arXiv ID / URL, and fetch citations from doi.org."""

import html
import json
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request

try:  # python.org / venv builds may lack system root certificates; certifi ships a current bundle
    import certifi
    _SSL = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL = ssl.create_default_context()

UA = "Mozilla/5.0 (Macintosh; Mac OS X) PaperReader/1.3 (personal reading tool)"
DOI_RE = re.compile(r"\b(10\.\d{4,9}/[^\s\"<>{}]+)", re.I)
ARXIV_RE = re.compile(r"(?:arxiv\.org/(?:abs|pdf)/|arxiv:\s*)?(\d{4}\.\d{4,5})(v\d+)?", re.I)


class LookupError_(Exception):
    pass


def _get(url: str, accept: str = "*/*", timeout: int = 40) -> tuple[bytes, str]:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    with urllib.request.urlopen(req, timeout=timeout, context=_SSL) as r:
        return r.read(), r.headers.get("Content-Type", "")


def clean_doi(s: str) -> str | None:
    m = DOI_RE.search(urllib.parse.unquote(s or ""))
    return m.group(1).rstrip(".,;)]") if m else None


def find_doi_in_text(text: str) -> str | None:
    """First DOI printed in the paper (usually on page 1)."""
    return clean_doi(text)


def _download_pdf(url: str) -> bytes:
    data, ctype = _get(url, "application/pdf,*/*")
    if not data.startswith(b"%PDF"):
        raise LookupError_("not a PDF")
    return data


def fetch_pdf(query: str) -> tuple[bytes, str]:
    """Returns (pdf bytes, suggested filename). Raises LookupError_ with a readable reason."""
    q = query.strip()
    tried = []
    arx = ARXIV_RE.fullmatch(q) or (("arxiv" in q.lower()) and ARXIV_RE.search(q))
    if arx:
        aid = arx.group(1) + (arx.group(2) or "")
        return _download_pdf(f"https://arxiv.org/pdf/{aid}"), f"arXiv {aid}.pdf"
    doi = clean_doi(q)
    if doi:
        title = doi.replace("/", "_")
        try:  # Semantic Scholar knows the open-access PDF for most papers
            meta, _ = _get(f"https://api.semanticscholar.org/graph/v1/paper/DOI:{urllib.parse.quote(doi)}?fields=title,openAccessPdf,externalIds")
            meta = json.loads(meta)
            title = meta.get("title") or title
            url = (meta.get("openAccessPdf") or {}).get("url")
            if url:
                try:
                    return _download_pdf(url), f"{title[:150]}.pdf"
                except Exception:
                    tried.append(url)
            arxiv_id = (meta.get("externalIds") or {}).get("ArXiv")
            if arxiv_id:
                return _download_pdf(f"https://arxiv.org/pdf/{arxiv_id}"), f"{title[:150]}.pdf"
        except Exception:
            pass
        try:  # Europe PMC open-access full text
            res, _ = _get("https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&resultType=core&query="
                          + urllib.parse.quote(f'DOI:"{doi}"'))
            for r in json.loads(res)["resultList"]["result"][:1]:
                for u in (r.get("fullTextUrlList") or {}).get("fullTextUrl", []):
                    if u.get("documentStyle") == "pdf" and u.get("availability") in ("Open access", "Free"):
                        try:
                            return _download_pdf(u["url"]), f"{(r.get('title') or title)[:150]}.pdf"
                        except Exception:
                            tried.append(u["url"])
        except Exception:
            pass
        raise LookupError_(f"No free PDF could be downloaded for {doi}. It may be paywalled. "
                           f"Open https://doi.org/{doi} in your browser, save the PDF, and drop it here.")
    if q.lower().startswith(("http://", "https://")):
        try:
            return _download_pdf(q), (urllib.parse.urlparse(q).path.rsplit("/", 1)[-1] or "paper") .removesuffix(".pdf") + ".pdf"
        except LookupError_:
            raise LookupError_("That link isn't a direct PDF (it's probably a web page). Look for the site's 'Download PDF' link, or paste the DOI instead.")
        except Exception as e:
            raise LookupError_(f"Couldn't download that link ({e}).")
    raise LookupError_("Paste a DOI (10.xxxx/…), an arXiv ID (2104.14294) or a direct link to a PDF.")


def citations(doi: str) -> dict:
    """BibTeX + APA + RIS from doi.org content negotiation (no key needed)."""
    out = {"doi": doi}
    for key, accept in (("bibtex", "application/x-bibtex"), ("apa", "text/x-bibliography; style=apa; locale=en-US"),
                        ("ris", "application/x-research-info-systems")):
        try:
            data, _ = _get(f"https://doi.org/{urllib.parse.quote(doi, safe='/')}", accept, timeout=20)
            out[key] = html.unescape(data.decode("utf-8", "replace")).replace("&Amp;", "&").strip()
        except Exception:
            out[key] = ""
    if not any(out[k] for k in ("bibtex", "apa", "ris")):
        raise LookupError_("Couldn't reach doi.org (no internet?).")
    return out


def related(doi: str) -> dict:
    """Impact numbers, a one-line TL;DR, and similar papers from Semantic Scholar (free; rate-limited)."""
    base = "https://api.semanticscholar.org"
    try:
        meta, _ = _get(f"{base}/graph/v1/paper/DOI:{urllib.parse.quote(doi)}"
                       "?fields=paperId,title,year,venue,citationCount,influentialCitationCount,tldr,externalIds", timeout=20)
        meta = json.loads(meta)
    except urllib.error.HTTPError as e:
        if e.code == 429:
            raise LookupError_("Semantic Scholar is busy (rate limit). Try again in a minute.")
        if e.code == 404:
            raise LookupError_("Semantic Scholar doesn't know this paper yet.")
        raise LookupError_(f"Semantic Scholar error ({e.code}).")
    except Exception:
        raise LookupError_("Couldn't reach Semantic Scholar (no internet?).")
    out = {
        "citations": meta.get("citationCount"), "influential": meta.get("influentialCitationCount"),
        "tldr": (meta.get("tldr") or {}).get("text", ""), "s2": f"https://www.semanticscholar.org/paper/{meta.get('paperId', '')}",
        "pmid": (meta.get("externalIds") or {}).get("PubMed"), "similar": [],
    }
    try:
        rec, _ = _get(f"{base}/recommendations/v1/papers/forpaper/{meta['paperId']}"
                      "?limit=8&fields=title,year,venue,citationCount,externalIds,openAccessPdf", timeout=20)
        for r in json.loads(rec).get("recommendedPapers", []):
            ids = r.get("externalIds") or {}
            out["similar"].append({"title": r.get("title", ""), "year": r.get("year"), "venue": r.get("venue", ""),
                                   "citations": r.get("citationCount"), "doi": ids.get("DOI"),
                                   "arxiv": ids.get("ArXiv"), "oa": bool((r.get("openAccessPdf") or {}).get("url"))})
    except Exception:
        pass          # similar papers are a bonus; keep the impact numbers
    return out
