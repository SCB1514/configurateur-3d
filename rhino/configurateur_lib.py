# -*- coding: utf-8 -*-
"""
================================================================
 CONFIGURATEUR 3D — moteur partage (Rhino 7 / 8)
================================================================
Ce module ne fait rien tout seul : il est importe par les
commandes cmd_*.py. Il regroupe

  * la detection des POINTS D'INSERTION,
  * le maillage des definitions de blocs,
  * la lecture du catalogue CSV,
  * l'ecriture de library.json,
  * la publication du fichier sur GitHub (API Contents).

----------------------------------------------------------------
 POINTS D'INSERTION
----------------------------------------------------------------
Dans Rhino, on place A L'INTERIEUR d'une definition de bloc des
instances d'un petit bloc nomme :

        Point d'insertion A
        Point d'insertion B
        Point d'insertion C   ...

Sont egalement reconnus :  "Point insertion A", "PI_A", "PT INS A".

Ces blocs ne sont PAS maillés : ils deviennent des connecteurs.
  * position  = point de base de l'instance ;
  * direction = axe Z de l'instance (la ou "sort" la connexion).

Dans le configurateur, deux blocs portant la meme lettre
s'aimantent : le connecteur A de l'un vient sur le connecteur A
de l'autre, oriente en vis-a-vis.

Convention utile : orientez l'axe Z du point d'insertion vers
l'EXTERIEUR du bloc (vers le voisin a connecter).
================================================================
"""

import base64
import codecs
import json
import os
import re

import Rhino
import scriptcontext as sc

# --------------------------------------------------------------- reglages
DECIMALS = 3
MESH_QUALITY = "render"          # "render" | "smooth" | "coarse"
SKIP_PREFIX = "_"
CURRENCY = u"€"
PRICE_ENABLED = True

# noms reconnus comme points d'insertion.
# Formes longues : separateur facultatif ("Point d'insertion A", "Point insertionB").
# Formes courtes : separateur obligatoire, sinon "Pilier" serait pris pour "PI lier".
CONNECTOR_RE_LONG = re.compile(
    r"^\s*point[\W_]*(?:d[\W_]*)?insertion[\W_]*([A-Za-z0-9]{1,4})\s*$", re.IGNORECASE)
CONNECTOR_RE_SHORT = re.compile(
    r"^\s*(?:pi|pt\s*ins)[\W_]+([A-Za-z0-9]{1,4})\s*$", re.IGNORECASE)

GRID_BY_UNIT = {"mm": 50, "cm": 5, "m": 0.05, "in": 2, "ft": 0.25}


# --------------------------------------------------------------- outils
def _round(v):
    return round(float(v), DECIMALS)


def doc_of(sc_module=None):
    d = sc.doc
    return d if hasattr(d, "InstanceDefinitions") else Rhino.RhinoDoc.ActiveDoc


def unit_name(doc):
    US = Rhino.UnitSystem
    return {US.Millimeters: "mm", US.Centimeters: "cm", US.Meters: "m",
            US.Inches: "in", US.Feet: "ft"}.get(doc.ModelUnitSystem, "m")


def mesh_params():
    MP = Rhino.Geometry.MeshingParameters
    if MESH_QUALITY == "coarse":
        return MP.FastRenderMesh
    if MESH_QUALITY == "smooth":
        return MP.Smooth
    return MP.QualityRenderMesh


def color_hex(c):
    return "#%02X%02X%02X" % (c.R, c.G, c.B)


def truthy(v):
    return str(v).strip().lower() in ("1", "true", "vrai", "oui", "yes", "x")


def slugify(s):
    out, prev = [], False
    for ch in (s or "").lower():
        if ch.isalnum():
            out.append(ch); prev = False
        elif not prev:
            out.append("-"); prev = True
    return "".join(out).strip("-") or "bloc"


def connector_type(name):
    """Retourne la lettre du point d'insertion, ou None si ce n'en est pas un."""
    n = name or ""
    m = CONNECTOR_RE_LONG.match(n) or CONNECTOR_RE_SHORT.match(n)
    return m.group(1).upper() if m else None


# --------------------------------------------------------------- catalogue CSV
def read_catalog_csv(doc):
    if not doc.Path:
        return {}
    csv_path = os.path.join(os.path.dirname(doc.Path), "catalogue.csv")
    if not os.path.exists(csv_path):
        return {}
    try:
        f = codecs.open(csv_path, "r", "utf-8-sig")
        lines = [l.rstrip("\r\n") for l in f.readlines() if l.strip()]
        f.close()
    except Exception as e:
        print("catalogue.csv illisible : %s" % e)
        return {}
    if not lines:
        return {}

    sep = ";" if lines[0].count(";") >= lines[0].count(",") else ","
    header = [h.strip().lower() for h in lines[0].split(sep)]
    rows = {}
    for line in lines[1:]:
        cells = line.split(sep)
        rec = {}
        for i, h in enumerate(header):
            rec[h] = cells[i].strip() if i < len(cells) else ""
        key = (rec.get("bloc") or rec.get("nom") or "").strip().lower()
        if key:
            rows[key] = rec
    print("catalogue.csv : %d lignes" % len(rows))
    return rows


def parse_finishes(txt):
    out = []
    for part in (txt or "").split("|"):
        part = part.strip()
        if not part:
            continue
        name, color = part.split(":", 1) if ":" in part else (part, part)
        color = color.strip()
        if not color.startswith("#"):
            color = "#" + color
        out.append({"id": slugify(name), "name": name.strip(), "color": color})
    return out


# --------------------------------------------------------------- maillage
def geometry_to_meshes(geo, mp):
    G = Rhino.Geometry
    meshes = []
    if isinstance(geo, G.Mesh):
        meshes.append(geo.DuplicateMesh())
    elif isinstance(geo, G.Brep):
        res = G.Mesh.CreateFromBrep(geo, mp)
        if res:
            meshes.extend([m for m in res if m])
    elif isinstance(geo, G.Extrusion):
        res = G.Mesh.CreateFromBrep(geo.ToBrep(True), mp)
        if res:
            meshes.extend([m for m in res if m])
    elif hasattr(G, "SubD") and isinstance(geo, G.SubD):
        try:
            m = G.Mesh.CreateFromSubD(geo, 3)
            if m:
                meshes.append(m)
        except Exception:
            res = G.Mesh.CreateFromBrep(geo.ToBrep(G.SubDToBrepOptions.DefaultPacked), mp)
            if res:
                meshes.extend([m for m in res if m])
    return meshes


class Accumulator(object):
    """Fusionne les maillages par couleur pour limiter le nombre de parties."""

    def __init__(self):
        self.parts = {}

    def add(self, mesh, hexcolor, paintable):
        mesh.Faces.ConvertQuadsToTriangles()
        mesh.Normals.ComputeNormals()
        mesh.Compact()
        key = (hexcolor, bool(paintable))
        part = self.parts.setdefault(key, {"positions": [], "normals": [], "indices": []})

        base = len(part["positions"]) // 3
        verts, norms = mesh.Vertices, mesh.Normals
        has_n = norms.Count == verts.Count
        for i in range(verts.Count):
            v = verts[i]
            part["positions"].extend([_round(v.X), _round(v.Y), _round(v.Z)])
            if has_n:
                n = norms[i]
                part["normals"].extend([round(n.X, 4), round(n.Y, 4), round(n.Z, 4)])
        if not has_n:
            part["normals"] = []

        faces = mesh.Faces
        for i in range(faces.Count):
            f = faces[i]
            part["indices"].extend([base + f.A, base + f.B, base + f.C])
            if f.IsQuad:
                part["indices"].extend([base + f.A, base + f.C, base + f.D])

    def to_json(self):
        out = []
        for (hexcolor, paintable), p in self.parts.items():
            if not p["positions"]:
                continue
            m = {"color": hexcolor, "positions": p["positions"], "indices": p["indices"]}
            if p["normals"] and len(p["normals"]) == len(p["positions"]):
                m["normals"] = p["normals"]
            if paintable:
                m["paintable"] = True
            out.append(m)
        return out


# --------------------------------------------------------------- parcours
def collect(objects, doc, acc, meta, connectors, xform=None, depth=0):
    """Maille les objets d'une definition et releve les points d'insertion."""
    mp = mesh_params()
    G = Rhino.Geometry
    for ro in objects:
        geo = ro.Geometry
        attr = ro.Attributes

        for key in ("categorie", "category", "prix", "price", "ref", "description",
                    "finitions", "finishes", "empilable"):
            try:
                val = attr.GetUserString(key)
            except Exception:
                val = None
            if val:
                meta.setdefault(key, val)

        if isinstance(geo, G.InstanceReferenceGeometry):
            nested = doc.InstanceDefinitions.FindId(geo.ParentIdefId)
            if not nested:
                continue
            x = geo.Xform if xform is None else xform * geo.Xform

            kind = connector_type(nested.Name)
            if kind:
                # POINT D'INSERTION : jamais maille, devient un connecteur
                origin = x * G.Point3d.Origin
                zdir = x * G.Vector3d.ZAxis
                if not zdir.Unitize():
                    zdir = G.Vector3d.ZAxis
                connectors.append({
                    "type": kind,
                    "name": nested.Name,
                    "pos": [_round(origin.X), _round(origin.Y), _round(origin.Z)],
                    "dir": [round(zdir.X, 4), round(zdir.Y, 4), round(zdir.Z, 4)],
                })
                continue

            if depth > 6:
                continue
            collect(nested.GetObjects(), doc, acc, meta, connectors, x, depth + 1)
            continue

        meshes = geometry_to_meshes(geo, mp)
        if not meshes:
            continue
        try:
            col = color_hex(attr.DrawColor(doc))
        except Exception:
            col = "#B9C2CD"
        try:
            paintable = truthy(attr.GetUserString("finition") or "")
        except Exception:
            paintable = False
        for m in meshes:
            if xform is not None:
                m.Transform(xform)
            acc.add(m, col, paintable)


# --------------------------------------------------------------- bibliotheque
def build_library(doc, only_defs=None, verbose=True):
    """Construit le dictionnaire library.json a partir du document."""
    csv_rows = read_catalog_csv(doc)
    units = unit_name(doc)
    blocks, categories, kinds = [], {}, {}

    for idef in doc.InstanceDefinitions:
        if idef.IsDeleted:
            continue
        name = idef.Name or ""
        if SKIP_PREFIX and name.startswith(SKIP_PREFIX):
            continue
        if connector_type(name):
            continue                      # les blocs "point d'insertion" ne sont pas des produits
        if only_defs is not None and idef.Index not in only_defs:
            continue

        objects = idef.GetObjects()
        if not objects:
            continue

        acc, meta, connectors = Accumulator(), {}, []
        collect(objects, doc, acc, meta, connectors)
        meshes = acc.to_json()
        if not meshes:
            if verbose:
                print("  - %-32s ignore (aucune geometrie maillable)" % name)
            continue

        default_cat = ""
        try:
            layer = doc.Layers[objects[0].Attributes.LayerIndex]
            default_cat = (layer.FullPath or layer.Name).split("::")[0]
        except Exception:
            pass

        row = csv_rows.get(name.strip().lower(), {})

        def pick(*keys):
            for k in keys:
                if row.get(k):
                    return row[k]
                if meta.get(k):
                    return meta[k]
            return ""

        category = pick("categorie", "category") or default_cat or "Divers"
        price_txt = str(pick("prix", "price")).replace(",", ".").replace(" ", "")
        try:
            price = float(price_txt) if price_txt else 0.0
        except ValueError:
            price = 0.0

        block = {
            "id": slugify(name),
            "name": name,
            "category": category,
            "price": price,
            "ref": pick("ref"),
            "description": pick("description"),
            "meshes": meshes,
        }
        if connectors:
            block["connectors"] = connectors
            for c in connectors:
                kinds.setdefault(c["type"], 0)
                kinds[c["type"]] += 1

        fin = parse_finishes(pick("finitions", "finishes"))
        if fin:
            block["finishes"] = fin
            if not any(m.get("paintable") for m in meshes):
                for m in meshes:
                    m["paintable"] = True
        emp = pick("empilable")
        if emp and not truthy(emp):
            block["stackable"] = False

        blocks.append(block)
        categories.setdefault(category, {"id": category, "name": category})
        if verbose:
            nv = sum(len(m["positions"]) for m in meshes) // 3
            pts = ("".join(sorted(set(c["type"] for c in connectors)))) or "-"
            print("  + %-30s %-14s %6d sommets   points: %s" % (name[:30], category[:14], nv, pts))

    library = {
        "name": os.path.splitext(os.path.basename(doc.Path))[0] if doc.Path else u"Bibliothèque",
        "units": units,
        "gridStep": GRID_BY_UNIT.get(units, 0.05),
        "currency": CURRENCY,
        "priceEnabled": PRICE_ENABLED,
        "categories": list(categories.values()),
        "blocks": blocks,
    }
    if kinds:
        library["connectorTypes"] = [
            {"id": k, "name": u"Point d'insertion " + k} for k in sorted(kinds)]
    return library


def write_library(library, path):
    f = codecs.open(path, "w", "utf-8")
    json.dump(library, f, ensure_ascii=False, separators=(",", ":"))
    f.close()
    return os.path.getsize(path)


def library_bytes(library):
    return json.dumps(library, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


# --------------------------------------------------------------- publication
CONFIG_DIR = os.path.join(
    os.environ.get("APPDATA") or os.path.expanduser("~"), "Configurateur3D")
CONFIG_PATH = os.path.join(CONFIG_DIR, "publication.json")


def load_config():
    if os.path.exists(CONFIG_PATH):
        try:
            return json.load(codecs.open(CONFIG_PATH, "r", "utf-8"))
        except Exception as e:
            print("publication.json illisible : %s" % e)
    return {}


def save_config(cfg):
    if not os.path.isdir(CONFIG_DIR):
        os.makedirs(CONFIG_DIR)
    f = codecs.open(CONFIG_PATH, "w", "utf-8")
    json.dump(cfg, f, ensure_ascii=False, indent=2)
    f.close()
    return CONFIG_PATH


def _http(url, method="GET", token=None, payload=None):
    """Requete HTTPS compatible IronPython 2.7 et Python 3."""
    try:                                   # Python 3
        from urllib.request import Request, urlopen
        from urllib.error import HTTPError
    except ImportError:                    # IronPython 2.7
        from urllib2 import Request, urlopen, HTTPError

    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = Request(url, data=data)
    req.get_method = lambda: method
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "Configurateur3D-Rhino")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        resp = urlopen(req, timeout=60)
        return json.loads(resp.read().decode("utf-8")), None
    except HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            msg = json.loads(body).get("message", body[:200])
        except Exception:
            msg = body[:200]
        return None, "HTTP %d - %s" % (e.code, msg)
    except Exception as e:
        return None, str(e)


def publish_to_github(content_bytes, cfg, message):
    """Ecrit/actualise un fichier du depot via l'API Contents.

    cfg : {owner, repo, branch, path, token}
    Retourne (url_du_commit, erreur)
    """
    owner, repo = cfg.get("owner"), cfg.get("repo")
    branch = cfg.get("branch") or "main"
    path = cfg.get("path") or "data/library.json"
    token = cfg.get("token") or os.environ.get("GITHUB_TOKEN")
    if not (owner and repo and token):
        return None, "Configuration incomplete (owner / repo / token)."

    base = "https://api.github.com/repos/%s/%s/contents/%s" % (owner, repo, path)

    # sha du fichier existant (absent = creation)
    current, err = _http(base + "?ref=" + branch, token=token)
    sha = current.get("sha") if current else None
    if err and "404" not in err:
        return None, err

    payload = {
        "message": message,
        "content": base64.b64encode(content_bytes).decode("ascii"),
        "branch": branch,
    }
    if sha:
        payload["sha"] = sha

    res, err = _http(base, method="PUT", token=token, payload=payload)
    if err:
        return None, err
    return (res.get("commit") or {}).get("html_url"), None


def pages_url(cfg):
    u = cfg.get("pagesUrl")
    if u:
        return u.rstrip("/") + "/"
    if cfg.get("owner") and cfg.get("repo"):
        return "https://%s.github.io/%s/" % (cfg["owner"], cfg["repo"])
    return None
