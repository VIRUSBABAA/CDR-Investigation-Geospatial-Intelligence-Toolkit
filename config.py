import os
from datetime import timedelta

BASE_DIR = os.path.abspath(os.path.dirname(__file__))


class Config:
    SECRET_KEY = os.environ.get("SIGNALTRACE_SECRET_KEY", os.urandom(32).hex())
    SQLALCHEMY_DATABASE_URI = "sqlite:///" + os.path.join(BASE_DIR, "instance", "signaltrace.db")
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    UPLOAD_FOLDER = os.path.join(BASE_DIR, "instance", "uploads")
    MAX_CONTENT_LENGTH = 25 * 1024 * 1024  # 25 MB per upload
    ALLOWED_EXTENSIONS = {"xlsx", "xls", "csv"}
    PERMANENT_SESSION_LIFETIME = timedelta(hours=4)
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    TOWER_DB_PATH = os.path.join(BASE_DIR, "data", "mock_towers_pakistan.csv")
    # Anomalous movement speed threshold (km/h) used to flag impossible jumps
    ANOMALOUS_SPEED_KMH = 130
