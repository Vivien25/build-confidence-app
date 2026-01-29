
# Minimal logger setup
import logging

logging.basicConfig(
    filename='c:/Users/admin/Desktop/build-confidence-app/backend/debug_voice.log',
    level=logging.INFO,
    format='%(asctime)s %(message)s',
    filemode='a'
)

def log_debug(msg):
    try:
        logging.info(msg)
        print(msg)
    except:
        pass
