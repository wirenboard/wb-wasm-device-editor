pipeline {
    agent {
        label 'devenv'
    }
    stages {
        stage('Build') {
            agent {
                docker {
                    image 'registry.wirenboard.lan/emsdk:latest'
                    args '--entrypoint="" -u root:root'
                    reuseNode true
                }
            }
            steps {
                sh 'bash -c "source /emsdk/emsdk_env.sh; emmake make -f wasm.mk"'
            }
            post {
                success {
                    archiveArtifacts artifacts: 'wasm/module.*', fingerprint: true
                }
            }
        }
    }
}
