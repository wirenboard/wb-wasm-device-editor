pipeline {
    agent {
        label 'devenv'
    }
    stages {
        stage('Build WASM Module') {
            steps {
                sh 'docker pull registry.wirenboard.lan/emsdk:latest'
                sh 'docker run --rm -v /var/lib/docker/volumes/buildagent/_data/workspace/$(basename $(pwd)):/src registry.wirenboard.lan/emsdk:latest emmake make -f wasm.mk'
            }
            post {
                success {
                    archiveArtifacts artifacts: '**/wasm/module.*', fingerprint: true
                }
            }
        }
    }
}
