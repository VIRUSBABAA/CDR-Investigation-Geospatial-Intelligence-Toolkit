import os
import csv
import io
from datetime import datetime
from functools import wraps

from flask import Flask, render_template, request, redirect, url_for, flash, jsonify, Response, session
from flask_login import LoginManager, login_user, logout_user, login_required, current_user
from werkzeug.utils import secure_filename

from config import Config
from database.models import db, User, Case, CDRFile, CDRRecord
from utils.cdr_parser import parse_cdr_file
from utils.tower_lookup import lookup_cell
from utils.geo_utils import (
    build_trail, frequent_locations, activity_by_hour, call_type_breakdown, top_contacts,
    haversine_km, bearing_deg, bearing_label,
    actual_trail_distance_km, call_pattern_matrix, operator_handoffs, device_change_alerts,
)


def _enrich_records_for_api(db_records):
    """Add trail index, distance, bearing, and gap metadata to API payloads."""
    data = [r.to_dict() for r in db_records]
    recs_with_ts = []
    for d, r in zip(data, db_records):
        row = d | {"timestamp": r.timestamp}
        recs_with_ts.append(row)

    for i, d in enumerate(data):
        d["trail_index"] = i
        r = db_records[i]
        if i > 0:
            prev_d = data[i - 1]
            prev_r = db_records[i - 1]
            if r.timestamp and prev_r.timestamp:
                d["gap_from_prev_seconds"] = int((r.timestamp - prev_r.timestamp).total_seconds())
            else:
                d["gap_from_prev_seconds"] = None
            if d.get("latitude") and prev_d.get("latitude"):
                dist = haversine_km(prev_d["latitude"], prev_d["longitude"], d["latitude"], d["longitude"])
                bearing = bearing_deg(prev_d["latitude"], prev_d["longitude"], d["latitude"], d["longitude"])
                d["distance_from_prev_km"] = round(dist, 2)
                d["bearing_from_prev"] = bearing
                d["bearing_label"] = bearing_label(bearing)
            else:
                d["distance_from_prev_km"] = None
                d["bearing_from_prev"] = None
                d["bearing_label"] = None
        else:
            d["gap_from_prev_seconds"] = None
            d["distance_from_prev_km"] = None
            d["bearing_from_prev"] = None
            d["bearing_label"] = None

    return data, recs_with_ts


def create_app():
    app = Flask(__name__)
    app.config.from_object(Config)

    from config import BASE_DIR
    os.makedirs(os.path.join(BASE_DIR, "instance"), exist_ok=True)
    os.makedirs(Config.UPLOAD_FOLDER, exist_ok=True)

    db.init_app(app)

    login_manager = LoginManager()
    login_manager.login_view = "login"
    login_manager.init_app(app)

    @login_manager.user_loader
    def load_user(user_id):
        return User.query.get(int(user_id))

    with app.app_context():
        db.create_all()
        # First-run: create default admin/admin account if no users exist
        if User.query.count() == 0:
            admin = User(username="admin")
            admin.set_password("admin")
            db.session.add(admin)
            db.session.commit()
            print("[SignalTrace] Created default account -> username: admin / password: admin")
            print("[SignalTrace] Please change this password after first login.")

    # ---------- helpers ----------
    def allowed_file(filename):
        return "." in filename and filename.rsplit(".", 1)[1].lower() in Config.ALLOWED_EXTENSIONS

    def get_owned_case_or_404(case_id):
        case = Case.query.filter_by(id=case_id, owner_id=current_user.id).first()
        if not case:
            from flask import abort
            abort(404)
        return case

    # ---------- auth ----------
    @app.route("/login", methods=["GET", "POST"])
    def login():
        if current_user.is_authenticated:
            return redirect(url_for("dashboard"))
        if request.method == "POST":
            username = request.form.get("username", "").strip()
            password = request.form.get("password", "")
            user = User.query.filter_by(username=username).first()
            if user and user.check_password(password):
                login_user(user)
                session.permanent = True
                return redirect(url_for("dashboard"))
            flash("Invalid username or password.", "error")
        return render_template("login.html")

    @app.route("/logout")
    @login_required
    def logout():
        logout_user()
        return redirect(url_for("login"))

    @app.route("/account/change-password", methods=["POST"])
    @login_required
    def change_password():
        current_pw = request.form.get("current_password", "")
        new_pw = request.form.get("new_password", "")
        if not current_user.check_password(current_pw):
            flash("Current password is incorrect.", "error")
        elif len(new_pw) < 4:
            flash("New password must be at least 4 characters.", "error")
        else:
            current_user.set_password(new_pw)
            db.session.commit()
            flash("Password updated.", "success")
        return redirect(url_for("dashboard"))

    # ---------- dashboard / cases ----------
    @app.route("/")
    @login_required
    def dashboard():
        cases = Case.query.filter_by(owner_id=current_user.id, archived=False).order_by(Case.created_at.desc()).all()
        return render_template("dashboard.html", cases=cases)

    @app.route("/case/new", methods=["POST"])
    @login_required
    def new_case():
        name = request.form.get("name", "").strip()
        notes = request.form.get("notes", "").strip()
        if not name:
            flash("Case / victim name is required.", "error")
            return redirect(url_for("dashboard"))
        case = Case(name=name, notes=notes, owner_id=current_user.id)
        db.session.add(case)
        db.session.commit()
        flash(f"Case '{name}' created.", "success")
        return redirect(url_for("case_detail", case_id=case.id))

    @app.route("/case/<int:case_id>/archive", methods=["POST"])
    @login_required
    def archive_case(case_id):
        case = get_owned_case_or_404(case_id)
        case.archived = True
        db.session.commit()
        flash(f"Case '{case.name}' archived.", "success")
        return redirect(url_for("dashboard"))

    @app.route("/case/<int:case_id>")
    @login_required
    def case_detail(case_id):
        case = get_owned_case_or_404(case_id)
        files = CDRFile.query.filter_by(case_id=case.id).order_by(CDRFile.uploaded_at.desc()).all()
        total_records = CDRRecord.query.filter_by(case_id=case.id).count()
        return render_template("case_detail.html", case=case, files=files, total_records=total_records)

    # ---------- upload + processing ----------
    @app.route("/case/<int:case_id>/upload", methods=["POST"])
    @login_required
    def upload_cdr(case_id):
        case = get_owned_case_or_404(case_id)
        if not request.form.get("lawful_use_ack"):
            flash("You must confirm lawful authorization before importing a file.", "error")
            return redirect(url_for("case_detail", case_id=case.id))
        file = request.files.get("cdr_file")
        if not file or file.filename == "":
            flash("No file selected.", "error")
            return redirect(url_for("case_detail", case_id=case.id))
        if not allowed_file(file.filename):
            flash("Unsupported file type. Use .xlsx, .xls or .csv.", "error")
            return redirect(url_for("case_detail", case_id=case.id))

        safe_name = secure_filename(file.filename)
        stored_name = f"{case.id}_{int(datetime.utcnow().timestamp())}_{safe_name}"
        save_path = os.path.join(Config.UPLOAD_FOLDER, stored_name)
        file.save(save_path)

        try:
            parsed_records, skipped, mapping = parse_cdr_file(save_path)
        except ValueError as e:
            os.remove(save_path)
            flash(f"Import failed: {e}", "error")
            return redirect(url_for("case_detail", case_id=case.id))

        cdr_file = CDRFile(case_id=case.id, original_filename=safe_name,
                            stored_filename=stored_name, record_count=len(parsed_records))
        db.session.add(cdr_file)
        db.session.flush()  # get cdr_file.id

        for rec in parsed_records:
            if rec.get("latitude") is not None and rec.get("longitude") is not None:
                # Sheet already provided coordinates directly — use them as-is,
                # no need to consult the mock tower DB at all.
                lat, lon = rec["latitude"], rec["longitude"]
                operator = rec.get("service_provider") or "Unknown"
                address = rec.get("location_text") or "Coordinates provided in source file"
                confidence = "provided_in_file"
            else:
                tower = lookup_cell(rec["cell_id"], Config.TOWER_DB_PATH)
                lat, lon = tower["latitude"], tower["longitude"]
                operator = rec.get("service_provider") or tower["operator"]
                address = rec.get("location_text") or tower["address"]
                confidence = tower["location_confidence"]

            db.session.add(CDRRecord(
                case_id=case.id,
                file_id=cdr_file.id,
                source_number=rec["source_number"],
                dest_number=rec["dest_number"],
                imei=rec.get("imei", ""),
                imsi=rec.get("imsi", ""),
                service_provider=rec.get("service_provider", ""),
                location_text=rec.get("location_text", ""),
                call_type=rec["call_type"],
                timestamp=rec["timestamp"],
                duration_seconds=rec["duration_seconds"],
                cell_id=rec["cell_id"],
                tower_operator=operator,
                tower_address=address,
                latitude=lat,
                longitude=lon,
                location_confidence=confidence,
            ))
        db.session.commit()

        # Recompute trail analysis (speed/anomaly/dwell) across ALL of this
        # case's records together, since trails should span multiple files.
        _recompute_trail_for_case(case.id)

        msg = f"Imported {len(parsed_records)} records"
        if skipped:
            msg += f" ({skipped} rows skipped — missing date/time or location)"
        flash(msg + ".", "success")
        return redirect(url_for("case_detail", case_id=case.id))

    def _recompute_trail_for_case(case_id):
        records = CDRRecord.query.filter_by(case_id=case_id).order_by(CDRRecord.timestamp.asc()).all()
        as_dicts = [r.to_dict() for r in records]
        for d, r in zip(as_dicts, records):
            d["timestamp"] = r.timestamp  # keep as datetime for math
        annotated = build_trail(as_dicts, anomalous_speed_kmh=Config.ANOMALOUS_SPEED_KMH)
        for rec_obj, ann in zip(records, annotated):
            rec_obj.speed_from_prev_kmh = ann["speed_from_prev_kmh"]
            rec_obj.is_anomalous_jump = ann["is_anomalous_jump"]
            rec_obj.dwell_minutes_after = ann["dwell_minutes_after"]
        db.session.commit()

    @app.route("/case/<int:case_id>/file/<int:file_id>/delete", methods=["POST"])
    @login_required
    def delete_file(case_id, file_id):
        case = get_owned_case_or_404(case_id)
        cdr_file = CDRFile.query.filter_by(id=file_id, case_id=case.id).first()
        if cdr_file:
            try:
                os.remove(os.path.join(Config.UPLOAD_FOLDER, cdr_file.stored_filename))
            except OSError:
                pass
            db.session.delete(cdr_file)
            db.session.commit()
            _recompute_trail_for_case(case.id)
            flash("File removed.", "success")
        return redirect(url_for("case_detail", case_id=case.id))

    # ---------- map / timeline ----------
    @app.route("/case/<int:case_id>/map")
    @login_required
    def case_map(case_id):
        case = get_owned_case_or_404(case_id)
        return render_template("case_map.html", case=case)

    @app.route("/case/<int:case_id>/api/records")
    @login_required
    def api_records(case_id):
        case = get_owned_case_or_404(case_id)
        db_records = CDRRecord.query.filter_by(case_id=case.id).order_by(CDRRecord.timestamp.asc()).all()
        data, recs_with_ts = _enrich_records_for_api(db_records)

        timestamps = [r.timestamp for r in db_records if r.timestamp]
        contacts = set()
        for r in db_records:
            if r.dest_number:
                contacts.add(r.dest_number)
            if r.source_number:
                contacts.add(r.source_number)

        geo_records = [d for d in data if d.get("latitude") and d.get("longitude")]
        actual_distance = actual_trail_distance_km(geo_records)

        overview = {
            "total_calls": len(db_records),
            "total_duration_seconds": sum(r.duration_seconds or 0 for r in db_records),
            "unique_contacts": len(contacts),
            "unique_cell_ids": len({r.cell_id for r in db_records if r.cell_id}),
            "anomalous_jumps": sum(1 for r in db_records if r.is_anomalous_jump),
            "first_seen": min(timestamps).isoformat() if timestamps else None,
            "last_seen": max(timestamps).isoformat() if timestamps else None,
            "unique_imeis": len({r.imei for r in db_records if r.imei}),
            "geolocated_events": len(geo_records),
            "total_trail_distance_km": actual_distance,
            "excluded_jump_distance_km": round(
                sum(d.get("distance_from_prev_km") or 0 for d in geo_records if d.get("is_anomalous_jump")), 1
            ),
            "incoming_count": sum(1 for r in db_records if r.call_type == "incoming"),
            "outgoing_count": sum(1 for r in db_records if r.call_type == "outgoing"),
            "missed_count": sum(1 for r in db_records if r.call_type == "missed"),
            "sms_count": sum(1 for r in db_records if r.call_type == "sms"),
        }

        return jsonify({
            "case_id": case.id,
            "case_name": case.name,
            "records": data,
            "overview": overview,
            "frequent_locations": frequent_locations(recs_with_ts),
            "activity_by_hour": activity_by_hour([{"timestamp": r.timestamp} for r in db_records]),
            "call_type_breakdown": call_type_breakdown(data),
            "top_contacts_by_calls": top_contacts(recs_with_ts, sort_by="count"),
            "top_contacts_by_duration": top_contacts(recs_with_ts, sort_by="duration"),
            "call_pattern_matrix": call_pattern_matrix(recs_with_ts),
            "operator_handoffs": operator_handoffs(data),
            "device_change_alerts": device_change_alerts(data),
        })

    @app.route("/case/<int:case_id>/events")
    @login_required
    def case_events(case_id):
        case = get_owned_case_or_404(case_id)
        return render_template("case_events.html", case=case)

    @app.route("/case/<int:case_id>/event/<int:record_id>")
    @login_required
    def case_event_detail(case_id, record_id):
        case = get_owned_case_or_404(case_id)
        record = CDRRecord.query.filter_by(id=record_id, case_id=case.id).first_or_404()
        return render_template("case_event_detail.html", case=case, record=record)

    @app.route("/case/<int:case_id>/export/csv")
    @login_required
    def export_csv(case_id):
        case = get_owned_case_or_404(case_id)
        records = CDRRecord.query.filter_by(case_id=case.id).order_by(CDRRecord.timestamp.asc()).all()

        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["timestamp", "source_number", "dest_number", "call_type", "duration_seconds",
                          "cell_id", "tower_operator", "tower_address", "latitude", "longitude",
                          "location_confidence", "speed_from_prev_kmh", "is_anomalous_jump"])
        for r in records:
            writer.writerow([r.timestamp, r.source_number, r.dest_number, r.call_type, r.duration_seconds,
                              r.cell_id, r.tower_operator, r.tower_address, r.latitude, r.longitude,
                              r.location_confidence, r.speed_from_prev_kmh, r.is_anomalous_jump])

        filename = f"{case.name.replace(' ', '_')}_export.csv"
        return Response(buf.getvalue(), mimetype="text/csv",
                         headers={"Content-Disposition": f"attachment; filename={filename}"})

    @app.errorhandler(404)
    def not_found(e):
        return render_template("404.html"), 404

    return app


if __name__ == "__main__":
    app = create_app()
    app.run(host="127.0.0.1", port=5050, debug=False)
