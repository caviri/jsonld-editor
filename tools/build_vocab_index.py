#!/usr/bin/env python3
"""
Build the offline term index used by the Term Finder (data/vocabularies/index.json).

The editor ships a pre-built index of the vocabularies people reuse most, so term
search works instantly and offline. This script downloads each vocabulary from its
authoritative source, extracts its classes, properties, datatypes and named
individuals, and writes one compact JSON file.

    pip install rdflib
    python tools/build_vocab_index.py            # writes data/vocabularies/index.json

More vocabularies can be loaded at runtime in the browser (through the rete
engine), so this list only needs the common core.

Record layout (one array per term, to keep the file small):

    [vocab, local, kind, label, comment, domain, range, super, flags]

    vocab    index into "vocabularies"
    local    local name; the IRI is vocabularies[vocab].namespace + local
    kind     C class · O object property · D datatype property · A annotation
             property · P property (rdf:Property) · T datatype · I individual
    label    English label, or 0 when it equals the local name
    comment  English definition, plain text, at most 220 characters, or 0
    domain   list of CURIEs/IRIs (rdfs:domain, schema:domainIncludes, owl:unionOf)
    range    same, for rdfs:range / schema:rangeIncludes
    super    rdfs:subClassOf / rdfs:subPropertyOf / rdf:type (for individuals)
    flags    0, or a string: "p" pending (schema.org), "u" unstable/testing
"""

from __future__ import annotations

import datetime as _dt
import html
import json
import re
import sys
import urllib.request
from pathlib import Path

from rdflib import BNode, Graph, Literal, Namespace, URIRef
from rdflib.collection import Collection
from rdflib.namespace import OWL, RDF, RDFS, SKOS, XSD, DCTERMS

SCHEMA = Namespace("http://schema.org/")
VS = Namespace("http://www.w3.org/2003/06/sw-vocab-status/ns#")
PROV = Namespace("http://www.w3.org/ns/prov#")

LITERAL_RANGES = {
    "rdfs:Literal", "rdf:langString", "rdf:HTML", "rdf:JSON",
    "schema:Text", "schema:Number", "schema:Boolean", "schema:Date", "schema:DateTime",
    "schema:URL", "schema:Integer", "schema:Float", "schema:Time", "schema:CssSelectorType",
    "schema:XPathType", "schema:PronounceableText",
}

# Vocabularies bundled in the offline index. Order matters: it is the default
# ranking tie-breaker in the Term Finder (earlier = more commonly reused).
VOCABULARIES = [
    {"prefix": "schema", "namespace": "http://schema.org/", "title": "Schema.org",
     "homepage": "https://schema.org/",
     "source": "https://schema.org/version/latest/schemaorg-current-http.ttl", "format": "turtle"},
    {"prefix": "dcterms", "namespace": "http://purl.org/dc/terms/", "title": "DCMI Metadata Terms",
     "homepage": "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/",
     "source": "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/dublin_core_terms.ttl", "format": "turtle"},
    {"prefix": "foaf", "namespace": "http://xmlns.com/foaf/0.1/", "title": "FOAF",
     "homepage": "http://xmlns.com/foaf/spec/",
     "source": "http://xmlns.com/foaf/spec/index.rdf", "format": "xml"},
    {"prefix": "skos", "namespace": "http://www.w3.org/2004/02/skos/core#", "title": "SKOS",
     "homepage": "https://www.w3.org/TR/skos-reference/",
     "source": "https://www.w3.org/2009/08/skos-reference/skos.rdf", "format": "xml"},
    {"prefix": "prov", "namespace": "http://www.w3.org/ns/prov#", "title": "PROV-O",
     "homepage": "https://www.w3.org/TR/prov-o/",
     "source": "https://www.w3.org/ns/prov-o.ttl", "format": "turtle"},
    {"prefix": "org", "namespace": "http://www.w3.org/ns/org#", "title": "Organization Ontology",
     "homepage": "https://www.w3.org/TR/vocab-org/",
     "source": "https://www.w3.org/ns/org.ttl", "format": "turtle"},
    {"prefix": "dcat", "namespace": "http://www.w3.org/ns/dcat#", "title": "DCAT 3",
     "homepage": "https://www.w3.org/TR/vocab-dcat-3/",
     "source": "https://www.w3.org/ns/dcat3.ttl", "format": "turtle"},
    {"prefix": "dc", "namespace": "http://purl.org/dc/elements/1.1/", "title": "Dublin Core Elements 1.1",
     "homepage": "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/",
     "source": "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/dublin_core_elements.ttl", "format": "turtle"},
    {"prefix": "vann", "namespace": "http://purl.org/vocab/vann/", "title": "VANN (vocabulary annotations)",
     "homepage": "https://vocab.org/vann/",
     "source": "https://vocab.org/vann/vann-vocab-20100607.rdf", "format": "xml"},
    {"prefix": "time", "namespace": "http://www.w3.org/2006/time#", "title": "OWL-Time",
     "homepage": "https://www.w3.org/TR/owl-time/",
     "source": "https://www.w3.org/2006/time.ttl", "format": "turtle"},
    {"prefix": "sh", "namespace": "http://www.w3.org/ns/shacl#", "title": "SHACL",
     "homepage": "https://www.w3.org/TR/shacl/",
     "source": "https://www.w3.org/ns/shacl.ttl", "format": "turtle"},
    {"prefix": "owl", "namespace": "http://www.w3.org/2002/07/owl#", "title": "OWL 2",
     "homepage": "https://www.w3.org/TR/owl2-overview/",
     "source": "https://www.w3.org/2002/07/owl.ttl", "format": "turtle"},
    {"prefix": "rdfs", "namespace": "http://www.w3.org/2000/01/rdf-schema#", "title": "RDF Schema",
     "homepage": "https://www.w3.org/TR/rdf-schema/",
     "source": "https://www.w3.org/2000/01/rdf-schema.ttl", "format": "turtle"},
    {"prefix": "rdf", "namespace": "http://www.w3.org/1999/02/22-rdf-syntax-ns#", "title": "RDF",
     "homepage": "https://www.w3.org/TR/rdf11-concepts/",
     "source": "https://www.w3.org/1999/02/22-rdf-syntax-ns.ttl", "format": "turtle"},
    {"prefix": "xsd", "namespace": "http://www.w3.org/2001/XMLSchema#", "title": "XML Schema datatypes",
     "homepage": "https://www.w3.org/TR/xmlschema11-2/", "source": None, "format": None},
]

# XSD has no RDF serialisation of its own; these are the datatypes RDF 1.1 allows.
XSD_DATATYPES = {
    "string": "Character strings.",
    "boolean": "true / false.",
    "decimal": "Arbitrary-precision decimal numbers.",
    "integer": "Arbitrary-size integers.",
    "double": "64-bit floating point numbers.",
    "float": "32-bit floating point numbers.",
    "date": "Calendar dates, e.g. 2024-05-01.",
    "time": "Times of day, e.g. 13:20:00.",
    "dateTime": "Date and time with optional timezone, e.g. 2024-05-01T13:20:00Z.",
    "dateTimeStamp": "Date and time with required timezone.",
    "gYear": "Gregorian calendar year, e.g. 2024.",
    "gMonth": "Gregorian calendar month.",
    "gDay": "Gregorian calendar day of the month.",
    "gYearMonth": "Gregorian calendar year and month, e.g. 2024-05.",
    "gMonthDay": "Gregorian calendar month and day.",
    "duration": "Duration of time, e.g. P1Y2M.",
    "yearMonthDuration": "Duration of time in years and months only.",
    "dayTimeDuration": "Duration of time in days, hours, minutes and seconds only.",
    "byte": "-128…+127 (8 bit).",
    "short": "-32768…+32767 (16 bit).",
    "int": "-2147483648…+2147483647 (32 bit).",
    "long": "64-bit integers.",
    "unsignedByte": "0…255 (8 bit).",
    "unsignedShort": "0…65535 (16 bit).",
    "unsignedInt": "0…4294967295 (32 bit).",
    "unsignedLong": "0…18446744073709551615 (64 bit).",
    "positiveInteger": "Integers > 0.",
    "nonNegativeInteger": "Integers ≥ 0.",
    "negativeInteger": "Integers < 0.",
    "nonPositiveInteger": "Integers ≤ 0.",
    "hexBinary": "Hex-encoded binary data.",
    "base64Binary": "Base64-encoded binary data.",
    "anyURI": "Absolute or relative URIs and IRIs.",
    "language": "Language tags per BCP 47.",
    "normalizedString": "Whitespace-normalized strings.",
    "token": "Tokenized strings.",
    "NMTOKEN": "XML NMTOKENs.",
    "Name": "XML Names.",
    "NCName": "XML NCNames.",
}

KIND_BY_TYPE = {
    OWL.Class: "C", RDFS.Class: "C",
    OWL.ObjectProperty: "O", OWL.DatatypeProperty: "D", OWL.AnnotationProperty: "A",
    OWL.FunctionalProperty: "P", OWL.InverseFunctionalProperty: "O", OWL.TransitiveProperty: "O",
    OWL.SymmetricProperty: "O", OWL.AsymmetricProperty: "O", OWL.ReflexiveProperty: "O",
    OWL.IrreflexiveProperty: "O", OWL.OntologyProperty: "A",
    RDF.Property: "P", RDFS.Datatype: "T",
}
# When a term has several types, keep the most specific kind.
KIND_PRIORITY = {"C": 6, "T": 5, "O": 4, "D": 4, "A": 3, "P": 2, "I": 1}

MAX_COMMENT = 220


def fetch(url: str, fmt: str) -> bytes:
    accept = {"turtle": "text/turtle", "xml": "application/rdf+xml"}.get(fmt, "*/*")
    req = urllib.request.Request(url, headers={"Accept": accept, "User-Agent": "jsonld-editor-vocab-index/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def clean_text(value: str) -> str:
    text = html.unescape(re.sub(r"<[^>]+>", " ", value))
    text = re.sub(r"\[\[([^\]]+)\]\]", r"\1", text)          # schema.org [[Term]] links
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)      # markdown links
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > MAX_COMMENT:
        cut = text[:MAX_COMMENT].rsplit(" ", 1)[0]
        text = cut.rstrip(",;:") + "…"
    return text


def english(graph: Graph, subject, predicates) -> str | None:
    """First English (or untagged) literal for any of the predicates, in order."""
    for pred in predicates:
        best = None
        for obj in graph.objects(subject, pred):
            if not isinstance(obj, Literal):
                continue
            lang = (obj.language or "").lower()
            if lang in ("en", "en-us", "en-gb"):
                return str(obj)
            if not lang and best is None:
                best = str(obj)
        if best is not None:
            return best
    return None


def members(graph: Graph, node) -> list:
    """IRIs of a class expression: itself, or the members of an owl:unionOf list."""
    if isinstance(node, URIRef):
        return [node]
    if isinstance(node, BNode):
        out = []
        for lst in graph.objects(node, OWL.unionOf):
            try:
                out.extend(m for m in Collection(graph, lst) if isinstance(m, URIRef))
            except Exception:  # malformed list
                pass
        return out
    return []


def compact(iri: str, namespaces: list[tuple[str, str]]) -> str:
    for prefix, ns in namespaces:
        if iri.startswith(ns) and len(iri) > len(ns):
            local = iri[len(ns):]
            if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.\-]*", local):
                return f"{prefix}:{local}"
    return iri


def extract(graph: Graph, vocab: dict, namespaces) -> list[list]:
    ns = vocab["namespace"]
    terms: dict[URIRef, str] = {}

    for subject, _, typ in graph.triples((None, RDF.type, None)):
        if not isinstance(subject, URIRef) or not str(subject).startswith(ns) or str(subject) == ns:
            continue
        kind = KIND_BY_TYPE.get(typ)
        if kind is None:
            continue
        if KIND_PRIORITY[kind] > KIND_PRIORITY.get(terms.get(subject, ""), 0):
            terms[subject] = kind

    # Named individuals and enumeration members: typed with a class of this vocabulary.
    classes = {s for s, k in terms.items() if k == "C"}
    for subject, _, typ in graph.triples((None, RDF.type, None)):
        if isinstance(subject, URIRef) and str(subject).startswith(ns) and subject not in terms:
            if typ in classes or typ == OWL.NamedIndividual or typ == SKOS.Concept:
                terms[subject] = "I"

    # Properties used only through rdfs:domain/range declarations (e.g. old RDFS files).
    for subject in set(graph.subjects(RDFS.domain, None)) | set(graph.subjects(RDFS.range, None)):
        if isinstance(subject, URIRef) and str(subject).startswith(ns) and subject not in terms:
            terms[subject] = "P"

    records = []
    for subject, kind in terms.items():
        if (subject, OWL.deprecated, Literal(True)) in graph or any(graph.objects(subject, SCHEMA.supersededBy)):
            continue
        status = english(graph, subject, [VS.term_status]) or ""
        if status == "archaic":
            continue
        local = str(subject)[len(ns):]
        label = english(graph, subject, [RDFS.label, SKOS.prefLabel]) or local
        comment = english(graph, subject, [RDFS.comment, SKOS.definition, PROV.definition, DCTERMS.description])

        def collect(*preds):
            out = []
            for pred in preds:
                for obj in graph.objects(subject, pred):
                    out.extend(members(graph, obj))
            return sorted({compact(str(m), namespaces) for m in out})

        domain = collect(RDFS.domain, SCHEMA.domainIncludes)
        rng = collect(RDFS.range, SCHEMA.rangeIncludes)
        if kind == "I":
            sup = sorted({compact(str(t), namespaces) for t in graph.objects(subject, RDF.type)
                          if isinstance(t, URIRef) and t not in (OWL.NamedIndividual,)})
        else:
            sup = collect(RDFS.subClassOf, RDFS.subPropertyOf)

        # Refine a generic rdf:Property from its range, the way OWL would type it:
        # only literal ranges -> datatype property, only class ranges -> object property.
        if kind == "P" and rng:
            literal = [r.startswith("xsd:") or r in LITERAL_RANGES for r in rng]
            if all(literal):
                kind = "D"
            elif not any(literal):
                kind = "O"

        flags = 0
        if any(str(o) == "http://pending.schema.org" for o in graph.objects(subject, SCHEMA.isPartOf)):
            flags = "p"
        elif status in ("unstable", "testing"):
            flags = "u"

        records.append([
            local,
            kind,
            0 if label == local else label,
            clean_text(comment) if comment else 0,
            domain,
            rng,
            sup,
            flags,
        ])
    records.sort(key=lambda r: (r[1] != "C", r[0].lower()))
    return records


def main(argv: list[str]) -> int:
    root = Path(__file__).resolve().parent.parent
    out_path = root / "data" / "vocabularies" / "index.json"
    namespaces = [(v["prefix"], v["namespace"]) for v in VOCABULARIES]

    vocab_entries = []
    all_terms = []
    for idx, vocab in enumerate(VOCABULARIES):
        if vocab["prefix"] == "xsd":
            records = [[name, "T", 0, comment, [], [], [], 0] for name, comment in XSD_DATATYPES.items()]
        else:
            print(f"  fetching {vocab['prefix']:8} {vocab['source']}", file=sys.stderr)
            graph = Graph()
            graph.parse(data=fetch(vocab["source"], vocab["format"]), format=vocab["format"])
            records = extract(graph, vocab, namespaces)
        for rec in records:
            all_terms.append([idx] + rec)
        entry = {k: vocab[k] for k in ("prefix", "namespace", "title", "homepage", "source")}
        entry["count"] = len(records)
        vocab_entries.append(entry)
        print(f"  {vocab['prefix']:8} {len(records):5} terms", file=sys.stderr)

    payload = {
        "format": 1,
        "generated": _dt.date.today().isoformat(),
        "generator": "tools/build_vocab_index.py",
        "fields": ["vocab", "local", "kind", "label", "comment", "domain", "range", "super", "flags"],
        "vocabularies": vocab_entries,
        "terms": all_terms,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    out_path.write_text(text, encoding="utf-8")
    print(f"wrote {out_path} ({len(text) / 1024:.0f} KiB, {len(all_terms)} terms)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
